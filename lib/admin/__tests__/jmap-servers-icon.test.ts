import { describe, it, expect } from 'vitest';
import { parseJmapServers, redactJmapServers } from '@/lib/admin/jmap-servers';

const entry = (icon: unknown) => ({ id: 'north', label: 'North', url: 'https://mail.example.com', icon });

describe('jmap server icon', () => {
  it('keeps a trimmed http(s) URL and publishes it with the server', () => {
    const [parsed] = parseJmapServers([entry('  https://north.example/icon.svg  ')]);
    expect(parsed!.icon).toBe('https://north.example/icon.svg');
    expect(redactJmapServers([parsed!])[0]!.icon).toBe('https://north.example/icon.svg');
    expect(parseJmapServers([entry('http://intranet.example/icon.png')])[0]!.icon).toBe('http://intranet.example/icon.png');
  });

  it.each(['javascript:alert(1)', 'data:image/svg+xml,<svg/>', '/branding/icon.svg', 'not a url', '', 42, null])(
    'drops an icon that is not an absolute http(s) URL, keeping the server: %s',
    (icon) => {
      const parsed = parseJmapServers([entry(icon)]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).not.toHaveProperty('icon');
      expect(redactJmapServers(parsed)[0]).not.toHaveProperty('icon');
    },
  );
});
