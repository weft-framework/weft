"use strict";
// The server's version: the browser must never be given this one.
exports.shout = (s) => String(s).toUpperCase();
exports.count = (s) => `${String(s).length} chars`;
