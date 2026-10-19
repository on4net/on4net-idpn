import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { IdpnTheme } from '@idpn/contracts/theme';

import { IdpnRoot } from './idpn-root';

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
  });
});
