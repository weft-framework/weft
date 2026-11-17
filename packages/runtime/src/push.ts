export interface PushSubscriptionResult {
  json: string;
  endpoint: string;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function registration(worker: string): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register(worker, { scope: "/" });
}

export async function subscribePush(vapidPublicKey: string, worker = "/push-worker.js"): Promise<PushSubscriptionResult | null> {
  if (!pushSupported()) return null;
  try {
    if ((await Notification.requestPermission()) !== "granted") return null;
    const reg = await registration(worker);
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
    return { json: JSON.stringify(sub.toJSON()), endpoint: sub.endpoint };
  } catch {
    return null;
  }
}

export async function currentPush(): Promise<PushSubscriptionResult | null> {
  if (!pushSupported()) return null;
  try {
    const sub = await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription();
    return sub ? { json: JSON.stringify(sub.toJSON()), endpoint: sub.endpoint } : null;
  } catch {
    return null;
  }
}

export async function unsubscribePush(): Promise<string | null> {
  if (!pushSupported()) return null;
  try {
    const sub = await (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription();
    if (!sub) return null;
    await sub.unsubscribe();
    return sub.endpoint;
  } catch {
    return null;
  }
}
