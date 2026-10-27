import { describe, expect, it } from 'vitest';
import { classifySecretTool } from './secret-service';

// stderr strings captured from secret-tool 0.21 on Debian 13.
describe('secret-tool result classification', () => {
  it('reads exit 0 as found, verbatim', () => {
    expect(classifySecretTool({ code: 0, stdout: 'val\n2', stderr: '' })).toEqual({ status: 'found', value: 'val\n2' });
  });

  it('reads a silent non-zero exit as a missing item', () => {
    expect(classifySecretTool({ code: 1, stdout: '', stderr: '' })).toEqual({ status: 'absent' });
  });

  it.each([
    'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
    'secret-tool: The name org.freedesktop.secrets was not provided by any .service files\n',
    'secret-tool: Could not connect: No such file or directory\n',
  ])('treats a missing session bus or keyring daemon as unavailable: %s', (stderr) => {
    expect(classifySecretTool({ code: 1, stdout: '', stderr }).status).toBe('unavailable');
  });

  it('treats a missing secret-tool binary as unavailable', () => {
    expect(classifySecretTool({ code: null, stdout: '', stderr: 'secret-tool is not installed (libsecret-tools)', missing: true }))
      .toEqual({ status: 'unavailable', detail: 'secret-tool is not installed (libsecret-tools)' });
  });

  it('treats a running service that fails, or a timeout, as an error and never as absent', () => {
    expect(classifySecretTool({ code: 1, stdout: '', stderr: 'secret-tool: Cannot create an item in a locked collection\n' }))
      .toEqual({ status: 'error', detail: 'Cannot create an item in a locked collection' });
    expect(classifySecretTool({ code: null, stdout: '', stderr: '' }).status).toBe('error');
  });
});
