// Local device TTS provider: `say` + ffmpeg pipeline and voice discovery on
// macOS and Windows. All child processes and fs mocked; no binaries run.
// Module voice cache reset via resetModules.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ exec: [] }));
const state = vi.hoisted(() => ({
  execImpl: null, // (cmd, args) => stdout string or throws
  files: {}, // path suffix -> Buffer
}));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const execFile = (cmd, args, optsOrCb, maybeCb) => {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    calls.exec.push([cmd, args]);
    try {
      const stdout = state.execImpl(cmd, args);
      cb(null, stdout ?? '', '');
    } catch (e) {
      cb(e);
    }
  };
  // The SUT wraps execFile with promisify and destructures { stdout }, which
  // only works when the custom promisify symbol resolves an object.
  execFile[promisify.custom] = (cmd, args, opts) =>
    new Promise((res, rej) =>
      execFile(cmd, args, opts, (err, stdout, stderr) => (err ? rej(err) : res({ stdout, stderr })))
    );
  return { execFile };
});

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async (prefix) => `${prefix}XYZ`),
  readFile: vi.fn(async (path) => {
    const key = Object.keys(state.files).find((k) => path.endsWith(k));
    if (!key) throw new Error(`ENOENT: ${path}`);
    return state.files[key];
  }),
  rm: vi.fn(async () => {}),
}));

async function load() {
  vi.resetModules();
  const mod = await import('../../open-sse/handlers/ttsProviders/localDevice.js');
  return { provider: mod.default, fetchLocalDeviceVoices: mod.fetchLocalDeviceVoices };
}

const realPlatform = process.platform;
function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  calls.exec.length = 0;
  state.execImpl = () => '';
  state.files = {};
});
afterEach(() => setPlatform(realPlatform));

const MAC_VOICES = [
  'Alice               it_IT    # Ciao, mi chiamo Alice.',
  'Samantha            en_US    # Hello, my name is Samantha.',
  'garbage line without locale',
].join('\n');

describe('synthesize', () => {
  it('runs say then ffmpeg and returns the mp3 as base64', async () => {
    const mp3 = Buffer.from('fake-mp3-bytes');
    state.files['out.mp3'] = mp3;
    const { provider } = await load();
    const out = await provider.synthesize('hello world', 'Samantha');

    expect(out).toEqual({ base64: mp3.toString('base64'), format: 'mp3' });
    expect(provider.noAuth).toBe(true);

    const [sayCmd, sayArgs] = calls.exec[0];
    expect(sayCmd).toBe('say');
    expect(sayArgs.slice(0, 2)).toEqual(['-v', 'Samantha']);
    expect(sayArgs).toContain('hello world');

    const [ffCmd, ffArgs] = calls.exec[1];
    expect(ffCmd).toBe('ffmpeg');
    expect(ffArgs.some((a) => String(a).endsWith('out.aiff'))).toBe(true);
    expect(ffArgs.some((a) => String(a).endsWith('out.mp3'))).toBe(true);
  });

  it('omits -v when no voice is given', async () => {
    state.files['out.mp3'] = Buffer.from('x');
    const { provider } = await load();
    await provider.synthesize('hi', null);
    expect(calls.exec[0][1]).not.toContain('-v');
  });

  it('propagates a failure from say', async () => {
    state.execImpl = (cmd) => {
      if (cmd === 'say') throw new Error('say: command not found');
    };
    const { provider } = await load();
    await expect(provider.synthesize('hi', null)).rejects.toThrow(/say/);
  });
});

describe('fetchLocalDeviceVoices', () => {
  it('parses macOS say -v ? output and caches it', async () => {
    setPlatform('darwin');
    state.execImpl = (cmd, args) => {
      expect(cmd).toBe('say');
      expect(args).toEqual(['-v', '?']);
      return MAC_VOICES;
    };
    const { fetchLocalDeviceVoices } = await load();
    const voices = await fetchLocalDeviceVoices();

    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: 'Alice',
      name: 'Alice',
      locale: 'it_IT',
      lang: 'it',
      country: 'IT',
      gender: '',
    });

    const execCount = calls.exec.length;
    expect(await fetchLocalDeviceVoices()).toBe(voices); // cached
    expect(calls.exec.length).toBe(execCount);
  });

  it('parses Windows SAPI voices via powershell', async () => {
    setPlatform('win32');
    state.execImpl = (cmd) => {
      expect(cmd).toBe('powershell.exe');
      return JSON.stringify([
        { Name: 'Microsoft Zira Desktop', Culture: 'en-US', Gender: 2 },
        { Name: 'Microsoft David Desktop', Culture: 'en-GB', Gender: 'Male' },
      ]);
    };
    const { fetchLocalDeviceVoices } = await load();
    const voices = await fetchLocalDeviceVoices();

    expect(voices).toEqual([
      {
        id: 'Microsoft Zira Desktop',
        name: 'Microsoft Zira Desktop',
        locale: 'en_US',
        lang: 'en',
        country: 'US',
        gender: 'Female',
      },
      {
        id: 'Microsoft David Desktop',
        name: 'Microsoft David Desktop',
        locale: 'en_GB',
        lang: 'en',
        country: 'GB',
        gender: 'Male',
      },
    ]);
  });

  it('wraps a single (non-array) powershell object and defaults missing culture', async () => {
    setPlatform('win32');
    state.execImpl = () => JSON.stringify({ Name: 'Solo', Gender: 99 });
    const { fetchLocalDeviceVoices } = await load();
    const voices = await fetchLocalDeviceVoices();
    expect(voices).toEqual([
      { id: 'Solo', name: 'Solo', locale: 'en_US', lang: 'en', country: 'US', gender: '' },
    ]);
  });

  it('returns [] when voice discovery fails', async () => {
    setPlatform('darwin');
    state.execImpl = () => {
      throw new Error('no say here');
    };
    const { fetchLocalDeviceVoices } = await load();
    expect(await fetchLocalDeviceVoices()).toEqual([]);
  });
});
