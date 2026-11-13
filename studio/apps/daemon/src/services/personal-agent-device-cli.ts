import { spawn } from "node:child_process";

const MAX_REQUEST_BYTES = 96 * 1024;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
export type PaDeviceRequest = { method: string; endpoint: string; body?: unknown };

export function validatePaDeviceRequest(value: unknown): PaDeviceRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid PA device request");
  const { endpoint, method, body } = value as PaDeviceRequest;
  const task = /^\/tasks\/[A-Za-z0-9_-]{1,100}$/;
  const control = /^\/tasks\/[A-Za-z0-9_-]{1,100}\/(?:cancel|resume)$/;
  if (typeof endpoint !== "string" || !(
    method === "GET" && (endpoint === "" || task.test(endpoint)) ||
    method === "POST" && (endpoint === "/tasks" || control.test(endpoint))
  )) throw new Error("This PA command is unavailable over an SSH device");
  return { method, endpoint, ...(body === undefined ? {} : { body }) };
}

export async function readPaDeviceRequest(): Promise<PaDeviceRequest> {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    if ((bytes += buffer.length) > MAX_REQUEST_BYTES) throw new Error("PA device request is too large");
    buffers.push(buffer);
  }
  return validatePaDeviceRequest(JSON.parse(Buffer.concat(buffers).toString("utf8")));
}

export async function callPaDevice(host: string, request: PaDeviceRequest): Promise<unknown> {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/.test(host)) throw new Error("Use a configured SSH host alias");
  const body = JSON.stringify(validatePaDeviceRequest(request));
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("PA device request is too large");
  // A fixed remote command reads a bounded stdin payload. SSH supplies
  // authentication, encryption, and host verification.
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no",
      "-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=10", "--", host, "od pa device-rpc",
    ], { stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(30000), windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REPLY_BYTES) {
        child.kill();
        reject(new Error("PA device reply exceeded its size limit"));
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error("Could not reach Fantay PA on the SSH host"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("The SSH host returned an invalid PA response")); }
    });
    child.stdin.end(body);
  });
}
