import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

function bootId() { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } }
function startTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return /^\d+$/.test(value || '') ? value : null;
  } catch { return null; }
}

const key = Symbol.for('tokenproxy.backendTelemetryClock');
export const backendClock = globalThis[key] ??= Object.freeze({
  clockDomain: randomUUID(), pid: process.pid, hostname: os.hostname(),
  bootId: bootId(), startTicks: startTicks(process.pid), startedAt: new Date().toISOString(),
});

export function ownerIsDead(owner, current = backendClock, inspectStart = startTicks, signal = process.kill) {
  if (!owner || owner.hostname !== current.hostname || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  if (owner.bootId && current.bootId && owner.bootId !== current.bootId) return true;
  const ticks = inspectStart(owner.pid);
  if (owner.startTicks && ticks && owner.startTicks !== ticks) return true;
  try { signal(owner.pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
