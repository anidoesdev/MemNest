import type { GraphTheme } from '@memnest/ui-core';
import { useEffect, useState } from 'react';

/**
 * Reads the graph theme from the CSS custom properties in styles.css, so canvas and DOM share one palette.
 * The graph follows the page: a glowing network on a dark ground, or soft colour on a light one.
 */
export function readGraphTheme(element: Element = document.documentElement): GraphTheme {
  const css = getComputedStyle(element);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ground: v('--brain-ground', 'dark') === 'light' ? 'light' : 'dark',
    background: v('--brain-space', '#060913'),
    spark: v('--brain-spark', '#ffffff'),
    kinds: { fact: v('--brain-fact', '#4cc6ff'), preference: v('--brain-preference', '#ffae45'), episode: v('--brain-episode', '#44f5a8') },
    cluster: v('--brain-cluster', '#8ea6ff'),
    clusterStroke: v('--brain-cluster-ring', '#c7d3ff'),
    edges: { updates: v('--brain-updates', '#a9b9ff'), extends: v('--brain-extends', '#8b7bff'), aggregate: v('--brain-aggregate', '#7d93e0') },
    label: v('--brain-label', '#e6ecff'),
    labelHalo: v('--brain-label-halo', 'rgba(6, 9, 19, 0.9)'),
    selection: v('--brain-selection', '#ffffff'),
    lineage: v('--brain-lineage', '#ff6ad5'),
    supersededAlpha: 0.35,
    forgottenAlpha: 0.6,
    font: `12px ${v('--font-sans', 'system-ui, sans-serif')}`,
  };
}

/** The graph theme, re-read when the system colour scheme or the theme switch changes. */
export function useGraphTheme(): GraphTheme {
  const [theme, setTheme] = useState(readGraphTheme);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => setTheme(readGraphTheme());
    media?.addEventListener('change', update);
    // The theme switch stamps data-theme on <html>.
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(update);
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      media?.removeEventListener('change', update);
      observer?.disconnect();
    };
  }, []);
  return theme;
}
