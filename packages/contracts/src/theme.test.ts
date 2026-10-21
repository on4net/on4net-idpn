import { describe, expect, it } from 'vitest';

import {
  IDPN_BASE_THEME,
  IDPN_THEME_COLOR_KEYS,
  IDPN_THEME_FONT_KEYS,
  MIN_CONTRAST_RATIO,
  contrastRatio,
  idpnThemeSchema,
  idpnThemeToCssVariables,
  resolveThemeColor,
  sanitizeIdpnColor,
  sanitizeIdpnFont,
  sanitizeIdpnRadius,
  sanitizeIdpnTheme,
} from './theme.js';

describe('theme color validation', () => {
  it.each([
    ['#0f766e', '#0f766e'],
    ['  #0F766E  ', '#0f766e'],
    ['#fff', '#fff'],
    ['#11223344', '#11223344'],
    ['rgb(15, 118, 110)', 'rgb(15, 118, 110)'],
    ['rgba(15, 118, 110, 0.5)', 'rgba(15, 118, 110, 0.5)'],
    ['rgb(15 118 110 / 50%)', 'rgb(15 118 110 / 50%)'],
    ['hsl(174 84% 24%)', 'hsl(174 84% 24%)'],
    ['hsla(174, 84%, 24%, 0.8)', 'hsla(174, 84%, 24%, 0.8)'],
    ['oklch(0.48 0.11 190)', 'oklch(0.48 0.11 190)'],
    ['oklch(48% 0.11 190 / 90%)', 'oklch(48% 0.11 190 / 90%)'],
    ['transparent', 'transparent'],
    ['WHITE', 'white'],
    ['currentColor', 'currentcolor'],
  ])('accepts %s', (input, expected) => {
    expect(sanitizeIdpnColor(input)).toBe(expected);
  });

  it.each([
    'red',
    'rgb(300, 0, 0)',
    'rgb(0 0 0 / 2)',
    'hsl(10 120% 50%)',
    'oklch(1.2 0.1 190)',
    '#12345',
    '8px',
    'transparent; background: url(https://evil.example/x)',
    'red; } body { display: none',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    'javascript:alert(1)',
    'var(--primary)',
    'red !important',
    '"red"',
    "'red'",
    'red\n',
    '#'.padEnd(120, 'a'),
    '<script>alert(1)</script>',
  ])('rejects %s', (input) => {
    expect(sanitizeIdpnColor(input)).toBeUndefined();
  });

  it('rejects non-string values', () => {
    expect(sanitizeIdpnColor(null)).toBeUndefined();
    expect(sanitizeIdpnColor(42)).toBeUndefined();
    expect(sanitizeIdpnColor({ color: 'red' })).toBeUndefined();
  });
});

describe('theme radius validation', () => {
  it.each(['0', '0px', '8px', '0.625rem', '12em', '50%'])('accepts %s', (input) => {
    expect(sanitizeIdpnRadius(input)).toBe(input);
  });

  it.each([
    '-4px',
    '8',
    '8 px',
    'calc(1rem + 2px)',
    '8px; color: red',
    '99999px',
    '8px !important',
  ])('rejects %s', (input) => {
    expect(sanitizeIdpnRadius(input)).toBeUndefined();
  });
});

describe('theme font validation', () => {
  it.each([
    ['Vazirmatn', 'vazirmatn'],
    ["'Inter'", 'inter'],
    ['system-ui', 'system'],
    ['SANS-SERIF', 'system'],
  ])('maps %s to an allowlisted stack', (input, expected) => {
    expect(sanitizeIdpnFont(input)).toBe(expected);
  });

  it.each([
    'Arial',
    'Inter; color: red',
    'url(https://evil.example/f.woff)',
    'Vazirmatn, sans-serif',
  ])('rejects %s', (input) => {
    expect(sanitizeIdpnFont(input)).toBeUndefined();
  });
});

describe('sanitizeIdpnTheme', () => {
  it('keeps valid fields, drops invalid and unknown fields', () => {
    const sanitized = sanitizeIdpnTheme({
      primary: '#0F766E',
      background: 'not-a-color',
      primaryForeground: 'white',
      radius: '8px',
      fontFamily: { rtl: 'Vazirmatn', ltr: 'Arial' },
      dark: { background: '#000000', primary: 'url(javascript:alert(1))' },
      unknownToken: '#123456',
      '--primary': '#123456',
    });

    expect(sanitized).toEqual({
      primary: '#0f766e',
      primaryForeground: 'white',
      radius: '8px',
      fontFamily: { rtl: 'vazirmatn' },
      dark: { background: '#000000' },
    });
  });

  it('returns an empty theme for non-object input', () => {
    expect(sanitizeIdpnTheme(null)).toEqual({});
    expect(sanitizeIdpnTheme('primary=red')).toEqual({});
    expect(sanitizeIdpnTheme(['#fff'])).toEqual({});
  });

  it('drops empty nested objects', () => {
    expect(sanitizeIdpnTheme({ fontFamily: { ltr: 'Comic Sans' }, dark: {} })).toEqual({});
  });
});

describe('idpnThemeToCssVariables', () => {
  it('maps only allowlisted tokens to --idpn-* variables', () => {
    const variables = idpnThemeToCssVariables(
      { primary: '#0f766e', radius: '8px', dark: { primary: '#5eead4' } },
      { dir: 'ltr' },
    );

    expect(variables['--idpn-primary']).toBe('#0f766e');
    expect(variables['--idpn-radius']).toBe('8px');
    expect(variables['--idpn-dark-primary']).toBe('#5eead4');
    expect(variables['--idpn-font-sans']).toContain("'Inter'");
    expect(variables).not.toHaveProperty('--primary');
    expect(variables).not.toHaveProperty('--radius');
    expect(Object.keys(variables).every((name) => name.startsWith('--idpn-'))).toBe(true);
  });

  it('applies the RTL font stack for fa-IR and the LTR stack for en-US', () => {
    const rtl = idpnThemeToCssVariables({}, { dir: 'rtl' });
    const ltr = idpnThemeToCssVariables({}, { dir: 'ltr' });

    expect(rtl['--idpn-font-sans']).toContain("'Vazirmatn'");
    expect(ltr['--idpn-font-sans']).toContain("'Inter'");
    expect(rtl['--idpn-font-rtl']).toContain("'Vazirmatn'");
    expect(ltr['--idpn-font-ltr']).toContain("'Inter'");
  });

  it('honours a client font override per direction', () => {
    const variables = idpnThemeToCssVariables(
      { fontFamily: { rtl: 'inter', ltr: 'vazirmatn' } },
      { dir: 'rtl' },
    );

    expect(variables['--idpn-font-sans']).toContain("'Inter'");
    expect(variables['--idpn-font-ltr']).toContain("'Vazirmatn'");
  });

  it('never emits a malicious value', () => {
    const variables = idpnThemeToCssVariables(
      {
        primary: 'red; } body { display: none',
        background: 'url(javascript:alert(1))',
        radius: '8px; color: red',
        fontFamily: { rtl: 'Inter; color: red' },
      },
      { dir: 'rtl' },
    );

    expect(variables['--idpn-primary']).toBeUndefined();
    expect(variables['--idpn-background']).toBeUndefined();
    expect(variables['--idpn-radius']).toBeUndefined();
    expect(JSON.stringify(variables)).not.toMatch(/display|url|javascript|color: red/i);
    expect(variables['--idpn-font-sans']).toContain("'Vazirmatn'");
  });

  it('covers every semantic color key', () => {
    expect(IDPN_THEME_COLOR_KEYS).toHaveLength(12);
    expect(IDPN_THEME_FONT_KEYS).toEqual(['vazirmatn', 'inter', 'system']);
  });
});

describe('idpnThemeSchema', () => {
  it('accepts the documented public shape and sanitizes unknown fields away', () => {
    const parsed = idpnThemeSchema.parse({
      primary: '#0f766e',
      radius: '8px',
      fontFamily: { rtl: 'vazirmatn', ltr: 'inter' },
      dark: { background: '#0a0a0a' },
      brand: '#123456',
    });

    // The schema tolerates extra keys (a branding row may carry them); the sanitizer is the
    // boundary that produces the theme the renderer sees.
    expect(parsed).toMatchObject({ brand: '#123456' });
    expect(sanitizeIdpnTheme(parsed)).toEqual({
      primary: '#0f766e',
      radius: '8px',
      fontFamily: { rtl: 'vazirmatn', ltr: 'inter' },
      dark: { background: '#0a0a0a' },
    });
  });

  it('rejects a malicious color or radius', () => {
    expect(idpnThemeSchema.safeParse({ primary: 'url(javascript:alert(1))' }).success).toBe(false);
    expect(idpnThemeSchema.safeParse({ radius: '8px; color: red' }).success).toBe(false);
    expect(idpnThemeSchema.safeParse({ fontFamily: { rtl: 'Arial' } }).success).toBe(false);
  });

  it('allows unknown keys so client rows keep their extra branding', () => {
    const parsed = idpnThemeSchema.parse({ primary: '#0f766e', brand: 'acme' });
    expect(parsed).toMatchObject({ primary: '#0f766e', brand: 'acme' });
    // The renderer only ever sees the sanitized shape.
    expect(sanitizeIdpnTheme(parsed)).toEqual({ primary: '#0f766e' });
  });
});

describe('theme colour and font edge cases', () => {
  it('rejects out-of-range channels, alphas and lightness values', () => {
    expect(sanitizeIdpnColor('rgb(300, 0, 0)')).toBeUndefined();
    expect(sanitizeIdpnColor('rgba(0, 0, 0, 2)')).toBeUndefined();
    expect(sanitizeIdpnColor('hsl(0 50% 50% / 2)')).toBeUndefined();
    expect(sanitizeIdpnColor('oklch(2 0 0)')).toBeUndefined();
    expect(sanitizeIdpnColor('hsl(400deg 50% 50%)')).toBeUndefined();
  });

  it('maps font aliases and drops unknown families', () => {
    expect(sanitizeIdpnFont('system-ui')).toBe('system');
    expect(sanitizeIdpnFont("'Vazirmatn'")).toBe('vazirmatn');
    expect(sanitizeIdpnFont('Comic Sans')).toBeUndefined();
    expect(sanitizeIdpnRadius('12')).toBeUndefined();
  });

  it('falls back to the locale default when no font is configured', () => {
    expect(idpnThemeToCssVariables({}, { locale: 'en-US' })['--idpn-font-sans']).toContain("'Inter'");
    expect(idpnThemeToCssVariables({}, { locale: 'fa-IR' })['--idpn-font-sans']).toContain(
      "'Vazirmatn'",
    );
    expect(idpnThemeToCssVariables({}, {})['--idpn-font-sans']).toContain("'Vazirmatn'");
    expect(idpnThemeToCssVariables({ fontFamily: { ltr: 'system' } }, { dir: 'ltr' })).toMatchObject(
      { '--idpn-font-ltr': 'system-ui, -apple-system, sans-serif' },
    );
  });
});
describe('theme contrast guard', () => {
  it('measures WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 boundary value for AA.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    expect(contrastRatio('#999999', '#ffffff')).toBeLessThan(MIN_CONTRAST_RATIO);
    // OKLCH (the palette format used by globals.css) resolves through OKLab.
    expect(contrastRatio('oklch(0.145 0 0)', 'oklch(1 0 0)')).toBeGreaterThan(15);
    expect(contrastRatio('hsl(0 0% 0%)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 5);
    expect(contrastRatio('transparent', '#ffffff')).toBeNull();
  });

  it('drops a client foreground that is invisible on its background', () => {
    // The exact example from the review: white text on a white background.
    expect(sanitizeIdpnTheme({ background: '#ffffff', foreground: '#ffffff' })).toEqual({});
    // Also when only the foreground is supplied and the built-in background is white.
    expect(sanitizeIdpnTheme({ foreground: '#ffffff' })).toEqual({});
  });

  it('drops a failing primary pair on the primary token', () => {
    expect(sanitizeIdpnTheme({ primary: '#ffffff', primaryForeground: '#ffffff' })).toEqual({});
  });

  it('resolves every supported colour syntax and rejects the rest', () => {    // rgb with percentage channels and an alpha channel.
    expect(resolveThemeColor('rgb(100% 0% 0% / 50%)')).toMatchObject({ r: 1, g: 0, b: 0 });
    // hsl with zero saturation is grey; a hue in turns is accepted.
    expect(resolveThemeColor('hsl(0 0% 50%)')).toMatchObject({ r: 0.5, g: 0.5, b: 0.5 });
    expect(resolveThemeColor('hsl(0.5turn 100% 50%)')).toMatchObject({ r: 0, b: 1 });
    // oklch with percentage lightness/chroma (floating point, so compare approximately).
    const white = resolveThemeColor('oklch(100% 0% 0)');
    expect(white?.r).toBeCloseTo(1, 5);
    expect(white?.g).toBeCloseTo(1, 5);
    expect(white?.b).toBeCloseTo(1, 5);
    // Shorthand hex and 8-digit hex.
    expect(resolveThemeColor('#fff')).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(resolveThemeColor('#000000ff')).toMatchObject({ r: 0, g: 0, b: 0 });
    // Values whose colour cannot be measured.
    expect(resolveThemeColor('transparent')).toBeNull();
    expect(resolveThemeColor('currentcolor')).toBeNull();
    expect(resolveThemeColor('#12345')).toBeNull();
    expect(contrastRatio('transparent', '#ffffff')).toBeNull();
  });

  it('keeps an accessible pair untouched', () => {
    const theme = { background: '#0b1020', foreground: '#f8fafc', primary: '#0f766e' };
    expect(sanitizeIdpnTheme(theme)).toEqual(theme);
  });

  it('applies the guard to dark-mode overrides against the dark palette', () => {
    expect(
      sanitizeIdpnTheme({ dark: { background: '#111111', foreground: '#0d0d0d' } }),
    ).toEqual({});
    const accessible = { dark: { background: '#111111', foreground: '#f5f5f5' } };
    expect(sanitizeIdpnTheme(accessible)).toEqual(accessible);
  });

  it('keeps the built-in palette above AA in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const base = IDPN_BASE_THEME[mode];
      expect(contrastRatio(base.foreground, base.background)).toBeGreaterThanOrEqual(
        MIN_CONTRAST_RATIO,
      );
      expect(contrastRatio(base.primaryForeground, base.primary)).toBeGreaterThanOrEqual(
        MIN_CONTRAST_RATIO,
      );
    }
  });
});
