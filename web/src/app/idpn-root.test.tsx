import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { IdpnTheme } from '@idpn/contracts/theme';

import { IdpnRoot, PortalContainerError, resolvePortalTarget, type PortalScope } from './idpn-root';

describe('IdpnRoot layout variants', () => {
  it('centres a standalone surface but leaves an embedded one to its host', () => {
    const { unmount } = render(
      <IdpnRoot locale="fa-IR" dir="rtl">
        <span>محتوا</span>
      </IdpnRoot>,
    );
    const standalone = screen.getByTestId('idpn-root');
    expect(standalone.style.minHeight).toBe('100vh');
    expect(standalone.style.display).toBe('grid');
    unmount();

    render(
      <IdpnRoot locale="fa-IR" dir="rtl" layout="embedded">
        <span>محتوا</span>
      </IdpnRoot>,
    );
    const embedded = screen.getByTestId('idpn-root');
    // The host (or the Shadow-DOM wrapper) owns the box; the module must not force 100vh.
    expect(embedded.style.minHeight).toBe('');
    expect(embedded.style.display).toBe('');
    expect(embedded.style.padding).toBe('');
    // Theme tokens are still applied.
    expect(embedded.style.getPropertyValue('--idpn-font-sans')).toContain("'Vazirmatn'");
  });
});

describe('IdpnRoot theme application', () => {
  it('writes sanitized tokens only to the .idpn-root element', () => {
    render(
      <IdpnRoot
        locale="fa-IR"
        dir="rtl"
        theme={{
          primary: '#0f766e',
          background: 'rgb(255, 255, 255)',
          radius: '12px',
          dark: { primary: '#5eead4' },
        }}
      >
        <span>content</span>
      </IdpnRoot>,
    );

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveClass('idpn-root');
    expect(root).not.toHaveClass('dark');
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('#0f766e');
    expect(root.style.getPropertyValue('--idpn-background')).toBe('rgb(255, 255, 255)');
    expect(root.style.getPropertyValue('--idpn-radius')).toBe('12px');
    expect(root.style.getPropertyValue('--idpn-dark-primary')).toBe('#5eead4');

    // Semantic shadcn variables are assigned inside globals.css, never inline on :root.
    expect(root.style.getPropertyValue('--primary')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--idpn-primary')).toBe('');
    expect(document.documentElement.getAttribute('style')).toBeNull();
  });

  it('applies the RTL font stack for fa-IR and the LTR stack for en-US', () => {
    const { unmount } = render(
      <IdpnRoot locale="fa-IR" dir="rtl">
        <span>محتوا</span>
      </IdpnRoot>,
    );

    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--idpn-font-sans')).toContain(
      "'Vazirmatn'",
    );
    unmount();

    render(
      <IdpnRoot locale="en-US" dir="ltr">
        <span>content</span>
      </IdpnRoot>,
    );

    const root = screen.getByTestId('idpn-root');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Inter'");
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root).toHaveAttribute('lang', 'en-US');
  });

  it('chooses the font stack from the locale, not only from the direction', () => {
    render(
      <IdpnRoot locale="fa-IR" dir="ltr">
        <span>محتوا</span>
      </IdpnRoot>,
    );

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveAttribute('dir', 'ltr');
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Vazirmatn'");
  });

  it('honours a per-direction font override from the client theme', () => {
    render(
      <IdpnRoot locale="en-US" dir="ltr" theme={{ fontFamily: { rtl: 'inter', ltr: 'vazirmatn' } }}>
        <span>content</span>
      </IdpnRoot>,
    );

    expect(screen.getByTestId('idpn-root').style.getPropertyValue('--idpn-font-sans')).toContain(
      "'Vazirmatn'",
    );
  });

  it('adds the dark class with the semantic direction attributes', () => {
    render(
      <IdpnRoot locale="fa-IR" dir="rtl" dark theme={{ dark: { background: '#0a0a0a' } }}>
        <span>محتوا</span>
      </IdpnRoot>,
    );

    const root = screen.getByTestId('idpn-root');
    expect(root).toHaveClass('idpn-root', 'dark');
    expect(root).toHaveAttribute('dir', 'rtl');
    expect(root).toHaveAttribute('lang', 'fa-IR');
    expect(root).toHaveAttribute('data-idpn-theme');
    expect(root.style.getPropertyValue('--idpn-dark-background')).toBe('#0a0a0a');
    expect(screen.getByTestId('idpn-portal-root').parentElement).toBe(root);
  });

  it('never writes a malicious value into the style attribute', () => {
    render(
      <IdpnRoot
        locale="fa-IR"
        dir="rtl"
        theme={
          {
            primary: 'red; } body { display: none',
            background: 'url(javascript:alert(1))',
            radius: '8px; color: red',
            fontFamily: { rtl: 'Inter; color: red' },
          } as unknown as IdpnTheme
        }
      >
        <span>محتوا</span>
      </IdpnRoot>,
    );

    const root = screen.getByTestId('idpn-root');
    expect(root.style.getPropertyValue('--idpn-primary')).toBe('');
    expect(root.style.getPropertyValue('--idpn-background')).toBe('');
    expect(root.style.getPropertyValue('--idpn-radius')).toBe('');
    expect(root.getAttribute('style')).not.toMatch(/javascript|color: red|url\(|body/i);
    expect(root.style.getPropertyValue('--idpn-font-sans')).toContain("'Vazirmatn'");
  });

  it('keeps two clients on the same page independent', () => {
    render(
      <div>
        <IdpnRoot locale="fa-IR" dir="rtl" theme={{ primary: '#111111' }}>
          <span>app a</span>
        </IdpnRoot>
        <IdpnRoot locale="en-US" dir="ltr" theme={{ primary: '#222222' }}>
          <span>app b</span>
        </IdpnRoot>
      </div>,
    );

    const roots = screen.getAllByTestId('idpn-root');
    expect(roots[0]?.style.getPropertyValue('--idpn-primary')).toBe('#111111');
    expect(roots[1]?.style.getPropertyValue('--idpn-primary')).toBe('#222222');
    expect(document.documentElement.getAttribute('style')).toBeNull();

    const portalRoots = screen.getAllByTestId('idpn-portal-root');
    expect(portalRoots).toHaveLength(2);
    expect(portalRoots[0]?.parentElement).toBe(roots[0]);
    expect(portalRoots[1]?.parentElement).toBe(roots[1]);
  });
});

describe('portal container contract', () => {
  it('uses an explicit container when provided', () => {
    const explicit = document.createElement('section');
    const scope: PortalScope = { container: document.createElement('div') };

    expect(resolvePortalTarget(explicit, scope, 'DialogContent')).toBe(explicit);
  });

  it('never falls back to document.body inside an IdpnRoot', () => {
    const scoped = document.createElement('div');
    const scope: PortalScope = { container: scoped };

    expect(resolvePortalTarget(undefined, scope, 'DialogContent')).toBe(scoped);

    // The ref has not committed yet: return null so the overlay waits instead of leaking.
    expect(resolvePortalTarget(undefined, { container: null }, 'DialogContent')).toBeNull();
  });

  it('keeps the document.body fallback for standalone surfaces only', () => {
    expect(resolvePortalTarget(undefined, null, 'DialogContent')).toBe(document.body);
  });

  it('rejects an explicit null container instead of silently using document.body', () => {
    expect(() => resolvePortalTarget(null, null, 'SelectContent')).toThrow(PortalContainerError);
    expect(() => resolvePortalTarget(null, { container: null }, 'DialogContent')).toThrow(
      /requires a portal container/,
    );
  });
});
