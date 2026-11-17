import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket } from "node:tls";
import { defineComponent, escapeHtml } from "@weft/runtime";
import { createJobs, MemoryJobStore } from "../src/jobs.ts";
import {
  buildMime,
  defineMail,
  htmlToText,
  MailError,
  Outbox,
  parseAddress,
  postmark,
  prepareMail,
  quotedPrintable,
  renderMail,
  renderTemplate,
  resend,
  ses,
  signAwsRequest,
  smtp,
  type OutgoingMail,
} from "../src/mail.ts";
import { Secret } from "../src/secret.ts";

const FROM = parseAddress("Acme <no-reply@acme.example>");
const prep = (m: Parameters<typeof prepareMail>[0]) => prepareMail(m, { from: FROM, maxBytes: 1 << 20 });

function unQP(s: string): string {
  const joined = s.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function unWords(s: string): string {
  return s.replace(/\r\n /g, "").replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_m, b: string) => Buffer.from(b, "base64").toString("utf8"));
}

async function rejects(p: Promise<unknown> | (() => unknown), check: (e: MailError) => void): Promise<void> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    assert.ok(e instanceof MailError, String(e));
    check(e);
    return;
  }
  assert.fail("expected a MailError");
}

test("addresses: forms accepted, anything that could add a header or recipient refused", async () => {
  assert.deepEqual(parseAddress("a@b.example"), { name: "", email: "a@b.example" });
  assert.deepEqual(parseAddress("Ada Lovelace <ada@b.example>"), { name: "Ada Lovelace", email: "ada@b.example" });
  assert.deepEqual(parseAddress('"Lovelace, Ada" <ada@b.example>'), { name: "Lovelace, Ada", email: "ada@b.example" });
  assert.deepEqual(parseAddress({ name: "Zoë", email: "z@xn--bcher-kva.example" }), { name: "Zoë", email: "z@xn--bcher-kva.example" });
  for (const bad of [
    "a@b.example\r\nBcc: eve@evil.example",
    "Ada\n <ada@b.example>",
    "ada@b.example, eve@evil.example",
    "<ada@b.example> <eve@evil.example>",
    "ada",
    "ada@",
    "ada@b",
    "a b@c.example",
    "ada@b.example>",
    `${"x".repeat(65)}@b.example`,
    "ada@-b.example",
  ]) {
    await rejects(() => parseAddress(bad), (e) => assert.equal(e.code, "invalid", bad));
  }
  await rejects(() => parseAddress({ name: "Eve\r\nBcc: x@y.example", email: "e@b.example" }), (e) => assert.equal(e.permanent, true));
});

test("messages: subject, headers, tags, size and recipient limits", async () => {
  const base = { to: "ada@b.example", subject: "Hi", text: "x" };
  await rejects(() => prep({ ...base, subject: "Hi\r\nBcc: eve@evil.example" }), (e) => assert.match(e.message, /subject/));
  await rejects(() => prep({ ...base, subject: " " }), () => {});
  await rejects(() => prep({ ...base, to: [] }), (e) => assert.match(e.message, /recipient/));
  await rejects(() => prep({ ...base, to: Array.from({ length: 51 }, (_, i) => `u${i}@b.example`) }), (e) => assert.match(e.message, /50/));
  await rejects(() => prep({ ...base, text: undefined }), (e) => assert.match(e.message, /text or html/));
  for (const h of ["Bcc", "content-type", "From", "Subject", "Message-ID", "Bad Name", "X:Y"]) {
    await rejects(() => prep({ ...base, headers: { [h]: "v" } }), (e) => assert.match(e.message, /cannot be set/, h));
  }
  await rejects(() => prep({ ...base, headers: { "X-Ref": "a\r\nBcc: eve@evil.example" } }), (e) => assert.match(e.message, /one line/));
  await rejects(() => prep({ ...base, headers: { "X-Ref": "é" } }), (e) => assert.match(e.message, /ASCII/));
  await rejects(() => prep({ ...base, tags: { "a b": "c" } }), () => {});
  await rejects(() => prep({ ...base, attachments: [{ filename: "a\r\n.pdf", content: "x" }] }), () => {});
  await rejects(() => prep({ ...base, attachments: [{ filename: "a.pdf", content: "x", contentType: "text/html\r\nX: y" }] }), () => {});
  await rejects(() => prep({ ...base, attachments: [{ filename: "big.bin", content: new Uint8Array(1 << 20) }] }), (e) => assert.match(e.message, /limit/));
  const m = prep({ ...base, html: "<p>Hello <b>there</b></p>", text: undefined, attachments: [{ filename: "../../etc/report.pdf", content: "x" }] });
  assert.equal(m.text, "Hello there", "text derived from html");
  assert.equal(m.attachments[0]!.filename, "report.pdf", "path stripped");
  assert.match(m.messageId, /^<[0-9a-f]{32}@acme\.example>$/);
});

test("MIME: 7-bit, quoted-printable bodies, encoded subject and names, no Bcc header", () => {
  const long = `${"é".repeat(60)} = trailing \n.leading dot\nend`;
  const m = prep({
    to: [{ name: "Zoë Ünal", email: "z@b.example" }, '"Doe, J" <j@b.example>'],
    bcc: "secret@b.example",
    subject: "Your receipt for 3 × café — № 42 ".repeat(3).trim(),
    text: long,
    html: "<p>Hi</p>",
    headers: { "List-Unsubscribe": "<https://acme.example/u/1>" },
    attachments: [{ filename: "facture-été.pdf", content: new Uint8Array(200).fill(7), contentType: "application/pdf" }],
  });
  const raw = buildMime(m);
  assert.ok(/^[\x00-\x7f]*$/.test(raw), "7-bit");
  for (const line of raw.split("\r\n")) assert.ok(line.length <= 78, `line too long: ${line.length}`);
  assert.ok(!/secret@b\.example/.test(raw), "Bcc never in the headers");
  assert.ok(!/\n(?!\r)|[^\r]\n/.test(raw.replace(/\r\n/g, "")), "CRLF only");
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  const subject = /\r\nSubject: ((?:.|\r\n )*)/.exec(head)![1]!;
  assert.equal(unWords(subject), m.subject);
  assert.match(unWords(head), /To: Zoë Ünal <z@b\.example>,\s*"Doe, J" <j@b\.example>/);
  assert.match(head, /\r\nList-Unsubscribe: <https:\/\/acme\.example\/u\/1>/);
  assert.match(head, /\r\nDate: \w{3}, \d\d \w{3} \d{4} \d\d:\d\d:\d\d \+0000/);
  assert.match(raw, /multipart\/mixed;\r\n boundary="=_weft_mix_/);
  assert.match(raw, /multipart\/alternative;\r\n boundary="=_weft_alt_/);
  assert.match(raw, /filename="facture-_t_.pdf";\r\n filename\*=UTF-8''facture-%C3%A9t%C3%A9.pdf/);
  const qp = /text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)![1]!;
  assert.equal(unQP(qp), long.replace(/\n/g, "\r\n"));
  assert.match(quotedPrintable("a \nb\t"), /^a=20\r\nb=09$/, "trailing blanks encoded");
  assert.equal(quotedPrintable("1+1=2"), "1+1=3D2");
});

test("text from HTML: links, lists, entities, no script or style", () => {
  const t = htmlToText(
    `<style>p{color:red}</style><h1>Welcome &amp; hi</h1><p>Click <a href="https://acme.example/a?b=1&amp;c=2">here</a>` +
      ` or <a href="javascript:alert(1)">bad</a>.</p><ul><li>One</li><li>Two&nbsp;&#x1F600;</li></ul><script>x()</script>` +
      `<a href="mailto:help@acme.example">help@acme.example</a>`,
  );
  assert.equal(t, "Welcome & hi\n\nClick here (https://acme.example/a?b=1&c=2) or bad.\n\n- One\n- Two \u{1F600}\n\nhelp@acme.example");
});

test("SigV4 matches AWS's published example", async () => {
  const h = await signAwsRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    region: "us-east-1",
    service: "iam",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: new Secret("k", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY") },
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    now: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, " +
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

interface FakeSmtp {
  port: number;
  commands: string[];
  data: string[];
  secure: boolean[];
  logins: string[];
  close(): Promise<void>;
}

async function fakeSmtp(o: {
  starttls?: { key: string; cert: string };
  auth?: string;
  rcpt?: (addr: string) => string;
  mail?: string;
} = {}): Promise<FakeSmtp> {
  const log: FakeSmtp = { port: 0, commands: [], data: [], secure: [], logins: [], close: async () => {} };
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    let s: Socket = sock;
    let secure = false;
    let buf = "";
    let inData = false;
    let body = "";
    let login = 0;
    const write = (l: string) => s.write(`${l}\r\n`);
    const onLine = (line: string) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          log.data.push(body);
          body = "";
          write("250 2.0.0 Ok: queued as ABC123");
        } else body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        return;
      }
      if (login > 0) {
        log.logins.push(Buffer.from(line, "base64").toString());
        login--;
        write(login ? "334 UGFzc3dvcmQ6" : "235 ok");
        return;
      }
      log.commands.push(line);
      log.secure.push(secure);
      const verb = line.split(" ")[0]!.toUpperCase();
      if (verb === "EHLO") {
        const caps = ["fake.example", "PIPELINING", ...(o.starttls && !secure ? ["STARTTLS"] : []), ...(o.auth ? [`AUTH ${o.auth}`] : [])];
        caps.forEach((c, i) => write(`250${i === caps.length - 1 ? " " : "-"}${c}`));
      } else if (verb === "STARTTLS" && o.starttls) {
        write("220 2.0.0 go ahead");
        s.removeAllListeners("data");
        const t = new TLSSocket(s, { isServer: true, key: o.starttls.key, cert: o.starttls.cert });
        t.on("error", () => {});
        t.on("data", onData);
        s = t;
        secure = true;
        buf = "";
      } else if (verb === "AUTH") {
        if (/^AUTH PLAIN /i.test(line)) {
          log.logins.push(Buffer.from(line.slice(11), "base64").toString());
          write("235 ok");
        } else {
          login = 2;
          write("334 VXNlcm5hbWU6");
        }
      } else if (verb === "MAIL") write(o.mail ?? "250 ok");
      else if (verb === "RCPT") write(o.rcpt?.(/<(.*)>/.exec(line)![1]!) ?? "250 ok");
      else if (verb === "DATA") {
        inData = true;
        write("354 go");
      } else if (verb === "QUIT") {
        write("221 bye");
        s.end();
      } else write("502 unknown");
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    sock.on("error", () => {});
    sock.on("data", onData);
    write("220 fake ESMTP");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  log.port = (server.address() as { port: number }).port;
  log.close = () => {
    for (const s of sockets) s.destroy();
    return new Promise((r) => server.close(() => r()));
  };
  return log;
}

const message = (): OutgoingMail =>
  prep({
    to: "ada@b.example",
    cc: "cc@b.example",
    bcc: "hidden@b.example",
    subject: "Report",
    text: "first\n.dot line\n..two dots\nlast",
  });

test("SMTP: the conversation, envelope recipients incl. Bcc, dot-stuffing, AUTH PLAIN and LOGIN", async () => {
  const srv = await fakeSmtp({ auth: "LOGIN PLAIN" });
  try {
    const t = smtp({ host: "127.0.0.1", port: srv.port, tls: "none", user: "u", pass: new Secret("p", "pw"), name: "app.example" });
    const r = await t.send(message());
    assert.equal(r.id, "ABC123");
    assert.deepEqual(srv.commands.slice(0, 2), ["EHLO app.example", srv.commands[1]]);
    assert.match(srv.commands[1]!, /^AUTH PLAIN /);
    assert.deepEqual(srv.logins, ["\0u\0pw"]);
    assert.deepEqual(srv.commands.slice(2), [
      "MAIL FROM:<no-reply@acme.example>",
      "RCPT TO:<ada@b.example>",
      "RCPT TO:<cc@b.example>",
      "RCPT TO:<hidden@b.example>",
      "DATA",
      "QUIT",
    ]);
    const data = srv.data[0]!;
    assert.ok(!data.includes("hidden@b.example"), "Bcc only in the envelope");
    const qp = data.slice(data.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
    assert.equal(unQP(qp), "first\r\n.dot line\r\n..two dots\r\nlast", "dots survive the transfer");
  } finally {
    await srv.close();
  }
  const srv2 = await fakeSmtp({ auth: "LOGIN" });
  try {
    await smtp({ host: "localhost", port: srv2.port, tls: "none", user: "u", pass: "pw" }).send(message());
    assert.deepEqual(srv2.logins, ["u", "pw"]);
  } finally {
    await srv2.close();
  }
});

test("SMTP: 5xx is permanent, 4xx and a dead server are transient; config refuses plain-text credentials", async () => {
  const srv = await fakeSmtp({ rcpt: (a) => (a.startsWith("cc") ? "550 5.1.1 no such user" : "250 ok") });
  try {
    await rejects(smtp({ host: "127.0.0.1", port: srv.port, tls: "none" }).send(message()), (e) => {
      assert.equal(e.permanent, true);
      assert.match(e.message, /RCPT TO: 550/);
    });
    assert.ok(!srv.commands.includes("DATA"));
  } finally {
    await srv.close();
  }
  const busy = await fakeSmtp({ mail: "451 4.3.0 try later" });
  try {
    await rejects(smtp({ host: "127.0.0.1", port: busy.port, tls: "none" }).send(message()), (e) => {
      assert.equal(e.permanent, false);
      assert.equal(e.code, "unavailable");
    });
  } finally {
    await busy.close();
  }
  const gone = await fakeSmtp();
  const port = gone.port;
  await gone.close();
  await rejects(smtp({ host: "127.0.0.1", port, tls: "none", timeoutMs: 2000 }).send(message()), (e) => assert.equal(e.permanent, false));
  assert.throws(() => smtp({ host: "smtp.acme.example", tls: "none", user: "u", pass: "p" }), /only sent over TLS/);
  assert.throws(() => smtp({ host: "smtp.acme.example", user: "u" }), /go together/);
  assert.throws(() => smtp({ host: "smtp.acme.example", name: "bad name\r\n" }), /EHLO|host name/);
});

function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "weft-mail-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pair = selfSigned();

test("SMTP: STARTTLS is required, verified, and nothing is sent before it", { skip: pair ? false : "openssl not found" }, async () => {
  const srv = await fakeSmtp({ starttls: pair!, auth: "PLAIN" });
  try {
    const ok = smtp({ host: "localhost", port: srv.port, user: "u", pass: "pw", tlsOptions: { ca: pair!.cert } });
    await ok.send(message());
    assert.equal(srv.commands[1], "STARTTLS");
    assert.deepEqual(srv.secure.slice(0, 3), [false, false, true], "EHLO again after the handshake");
    assert.ok(srv.commands.slice(2).every((_, i) => srv.secure[i + 2]), "AUTH and everything after over TLS");
    assert.equal(srv.data.length, 1);

    const before = srv.data.length;
    await rejects(smtp({ host: "localhost", port: srv.port, user: "u", pass: "pw" }).send(message()), (e) =>
      assert.equal(e.code, "unavailable"),
    );
    assert.equal(srv.data.length, before, "an unverified certificate stops the send");
  } finally {
    await srv.close();
  }
  const plain = await fakeSmtp({ auth: "PLAIN" });
  try {
    await rejects(smtp({ host: "127.0.0.1", port: plain.port, user: "u", pass: "pw" }).send(message()), (e) =>
      assert.match(e.message, /does not offer STARTTLS/),
    );
    assert.deepEqual(plain.commands, ["EHLO localhost"], "no AUTH, no MAIL in plain text");
    assert.deepEqual(plain.logins, []);
  } finally {
    await plain.close();
  }
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return respond(url, init);
  };
  return { f, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Resend and Postmark: request shape, secrets in headers only, error classes", async () => {
  const m = prep({
    to: "Ada <ada@b.example>",
    bcc: "hidden@b.example",
    subject: "Hi",
    text: "t",
    html: "<p>h</p>",
    tags: { kind: "welcome" },
    attachments: [{ filename: "a.txt", content: "abc", contentType: "text/plain" }],
  });
  const r = fakeFetch(() => json(200, { id: "re_1" }));
  assert.deepEqual(await resend({ apiKey: new Secret("k", "re_key"), fetch: r.f }).send(m), { id: "re_1" });
  const rc = r.calls[0]!;
  assert.equal(rc.url, "https://api.resend.com/emails");
  assert.equal((rc.init.headers as Record<string, string>).authorization, "Bearer re_key");
  assert.equal((rc.init.headers as Record<string, string>)["idempotency-key"], m.messageId.slice(1, -1));
  assert.deepEqual(rc.body.to, ["Ada <ada@b.example>"]);
  assert.deepEqual(rc.body.bcc, ["hidden@b.example"]);
  assert.deepEqual(rc.body.tags, [{ name: "kind", value: "welcome" }]);
  assert.deepEqual(rc.body.attachments, [{ filename: "a.txt", content: "YWJj", content_type: "text/plain" }]);
  assert.ok(!JSON.stringify(rc.body).includes("re_key"));

  const p = fakeFetch(() => json(200, { MessageID: "pm-1", ErrorCode: 0 }));
  assert.deepEqual(await postmark({ serverToken: "pm_key", messageStream: "outbound", fetch: p.f }).send(m), { id: "pm-1" });
  const pc = p.calls[0]!;
  assert.equal((pc.init.headers as Record<string, string>)["x-postmark-server-token"], "pm_key");
  assert.equal(pc.body.To, "Ada <ada@b.example>");
  assert.equal(pc.body.Bcc, "hidden@b.example");
  assert.equal(pc.body.MessageStream, "outbound");
  assert.deepEqual(pc.body.Metadata, { kind: "welcome" });

  for (const [status, permanent] of [[422, true], [401, true], [429, false], [503, false]] as const) {
    const t = resend({ apiKey: "k", fetch: fakeFetch(() => json(status, { message: "nope" })).f });
    await rejects(t.send(m), (e) => assert.equal(e.permanent, permanent, String(status)));
  }
  await rejects(postmark({ serverToken: "k", fetch: fakeFetch(() => json(200, { ErrorCode: 406, Message: "inactive" })).f }).send(m), (e) => {
    assert.equal(e.permanent, true);
    assert.match(e.message, /inactive/);
  });
  await rejects(resend({ apiKey: "k", fetch: async () => { throw new TypeError("fetch failed"); } }).send(m), (e) => assert.equal(e.permanent, false));
  assert.throws(() => resend({ apiKey: "" }), /apiKey/);
});

test("SES: signed request with the raw message; Bcc only in the destination", async () => {
  const m = prep({ to: "ada@b.example", bcc: "hidden@b.example", subject: "Hi", text: "t", tags: { kind: "x" } });
  const s = fakeFetch(() => json(200, { MessageId: "ses-1" }));
  const t = ses({ region: "eu-west-1", accessKeyId: "AKID", secretAccessKey: new Secret("s", "shh"), sessionToken: "tok", fetch: s.f, configurationSet: "main" });
  assert.deepEqual(await t.send(m), { id: "ses-1" });
  const c = s.calls[0]!;
  const headers = c.init.headers as Record<string, string>;
  assert.equal(c.url, "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
  assert.match(headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(headers["x-amz-security-token"], "tok");
  assert.ok(!JSON.stringify(c.body).includes("shh"));
  const dest = c.body.Destination as Record<string, unknown>;
  assert.deepEqual(dest.BccAddresses, ["hidden@b.example"]);
  const raw = Buffer.from((c.body.Content as { Raw: { Data: string } }).Raw.Data, "base64").toString();
  assert.match(raw, /\r\nSubject: Hi\r\n/);
  assert.ok(!raw.includes("hidden@b.example"));
  assert.deepEqual(c.body.EmailTags, [{ Name: "kind", Value: "x" }]);
  assert.equal(c.body.ConfigurationSetName, "main");
  assert.throws(() => ses({ region: "nowhere", accessKeyId: "a", secretAccessKey: "b" }), /region/);
});

test("queued mail: checked when queued, sent by the job with the same Message-ID, permanent errors dead at once", async () => {
  let clock = Date.UTC(2026, 10, 14, 10);
  let failure: MailError | null = null;
  const outbox = new Outbox();
  const transport = {
    name: "test",
    async send(mail: OutgoingMail) {
      if (failure) throw failure;
      return outbox.send(mail);
    },
  };
  const mail = defineMail({ transport, from: "Acme <no-reply@acme.example>", jobs: () => jobs });
  const jobs = createJobs({ jobs: [mail.job], store: new MemoryJobStore(), now: () => clock, random: () => 0.5 });

  await assert.rejects(mail.queue(null, { to: "bad\r\nBcc: x@y.example", subject: "x", text: "x" }), MailError);
  assert.equal((await jobs.counts()).queued, 0, "an invalid message is never queued");

  const id = (await mail.queue(null, {
    to: "ada@b.example",
    subject: "Invoice",
    text: "attached",
    attachments: [{ filename: "inv.pdf", content: new Uint8Array([1, 2, 3, 250]), contentType: "application/pdf" }],
  })) as string;
  failure = new MailError("unavailable", "smtp: 451");
  await jobs.drain();
  assert.equal((await jobs.get(id))!.status, "queued", "transient: retried later");
  failure = null;
  clock += 60_000;
  await jobs.drain();
  assert.equal((await jobs.get(id))!.status, "done");
  const sent = outbox.last("ada@b.example")!;
  assert.deepEqual([...sent.mail.attachments[0]!.content], [1, 2, 3, 250], "attachment bytes survive the queue");

  failure = new MailError("rejected", "smtp RCPT TO: 550 no such user", { permanent: true });
  const id2 = (await mail.queue(null, { to: "gone@b.example", subject: "x", text: "x" })) as string;
  await jobs.drain();
  const rec = (await jobs.get(id2))!;
  assert.deepEqual([rec.status, rec.attempts], ["dead", 1]);
  assert.match(rec.error!, /550/);

  await assert.rejects(defineMail({ transport, from: "a@b.example" }).queue(null, { to: "a@b.example", subject: "x", text: "x" }), /names the queue/);
});

test("send now and templates: escaped props, the component's CSS, a text version", async () => {
  const outbox = new Outbox({ limit: 2 });
  const mail = defineMail({ transport: outbox, from: "no-reply@acme.example" });
  const Welcome = defineComponent("Welcome", (p: { name: string }) => ({
    render: () => `<h1 class="w-1">Hi ${escapeHtml(p.name)}</h1><p><a href="https://acme.example/start?a=1&amp;b=2">Get started</a></p>`,
  }), { css: ".w-1{color:#123}" });
  const { html, text } = mail.render(Welcome, { name: "<script>x</script>" }, { title: "Welcome", lang: "fr" });
  assert.match(html, /^<!doctype html><html lang="fr"><head><meta charset="utf-8">/);
  assert.match(html, /<style>\.w-1\{color:#123\}<\/style>/);
  assert.match(html, /Hi &lt;script&gt;x&lt;\/script&gt;/);
  assert.equal(text, "Hi <script>x</script>\n\nGet started (https://acme.example/start?a=1&b=2)");
  const r = await mail.send({ to: "ada@b.example", subject: "Welcome", html, text });
  assert.equal(r.id, "outbox-1");
  for (let i = 0; i < 3; i++) await mail.send({ to: `u${i}@b.example`, subject: "x", text: "x" });
  assert.equal(outbox.sent.length, 2, "the outbox keeps the newest");
  assert.equal(outbox.last()!.mail.to[0]!.email, "u2@b.example");
  assert.throws(() => defineMail({ transport: outbox, from: "not an address" }), MailError);
});

test("templates are inert: handlers, mount hooks and islands are refused", () => {
  const Button = defineComponent("Button", () => ({ handlers: { go: () => {} }, render: () => `<button>go</button>` }));
  const Mounted = defineComponent("Mounted", () => ({ handlers: {}, mount: [() => {}], render: () => `<p>m</p>` }));
  const Island = defineComponent("Island", () => ({ handlers: {}, render: () => `<p>i</p>` }), { island: true });
  const Shell = defineComponent("Shell", (p: { inner: typeof Button }) => ({ handlers: {}, render: () => `<div>${p.inner({})}</div>` }));
  assert.throws(() => renderMail(Shell, { inner: Button }), /email templates are inert: Button has event handlers/);
  assert.throws(() => renderMail(Mounted, {}), /Mounted has mount hooks/);
  assert.throws(() => renderMail(Island, {}), /Island has browser code/);
  const Plain = defineComponent("Plain", (_p: { n: number }) => ({ handlers: {}, render: () => `<p>ok</p>` }));
  const r = renderTemplate({ component: Plain, subject: (p) => `Order\r\n${p.n}` }, { n: 7 });
  assert.equal(r.subject, "Order 7");
  assert.match(r.html, /<title>Order 7<\/title>/);
  assert.equal(renderTemplate({ component: Plain }, { n: 1 }).subject, null);
});

test("dev preview: lists every outbox, serves HTML under a sandbox CSP, escapes the list", async () => {
  const { mailPreview } = await import("../src/mail.ts");
  const outbox = new Outbox();
  const mail = defineMail({ transport: outbox, from: "no-reply@acme.example" });
  await mail.send({ to: "ada@b.example", bcc: "boss@b.example", subject: "<img src=x onerror=alert(1)>", html: "<p>Hello</p><script>alert(1)</script>" });
  const get = (p: string, method = "GET") => mailPreview(new Request(`http://localhost:3000${p}`, { method }));
  assert.equal(get("/about"), null, "other paths are the app's");
  const list = get("/_weft/dev/mail")!;
  const page = await list.text();
  assert.match(list.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!page.includes("<img src=x"));
  assert.match(page, /bcc boss@b\.example/);
  const html = get("/_weft/dev/mail/0.html")!;
  assert.match(html.headers.get("content-security-policy")!, /^sandbox; default-src 'none'/, "no script runs in the preview");
  assert.match(await html.text(), /<p>Hello<\/p>/);
  assert.match(await get("/_weft/dev/mail/0.eml")!.text(), /^From: no-reply@acme\.example\r\n/);
  assert.equal(get("/_weft/dev/mail/0.txt")!.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(get("/_weft/dev/mail/999.html")!.status, 404);
  assert.equal(get("/_weft/dev/mail/x.html")!.status, 404);
  assert.equal(get("/_weft/dev/mail/../x"), null, "normalised out of the preview");
  assert.equal(get("/_weft/dev/mail", "POST")!.status, 405);
});
