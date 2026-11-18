import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {
    CANONICAL_PROVIDERS,
    DEFAULT_HIDDEN_PROVIDERS,
    DEFAULT_PROVIDER_ORDER,
    PANEL_ACCOUNT_MODES,
    PANEL_MODES,
    POPOVER_LAYOUTS,
    PROVIDER_BY_ID,
    QUICK_THEME_IDS,
    SYSTEM_LIGHT_PALETTE,
    THEME_BY_ID,
    THEME_CATEGORIES,
    THEME_PRESETS,
    buildConfigUpsertArgs,
    buildPanelEntries,
    buildTerminalArgv,
    clampPercent,
    computeBucketPace,
    computePanelSummary,
    defaultCredentialWatchPaths,
    evaluateQuotaNotificationStep,
    filterVisibleProviders,
    formatAccountShortTag,
    formatBucketDisplayLabel,
    formatBucketMetric,
    formatClipboardSummary,
    formatCompactAccountExtraNote,
    formatCreditsSummary,
    formatPanelPillLabel,
    formatRelativeUpdated,
    formatResetCountdown,
    getActiveAccount,
    getBarFillRgba,
    getProviderAlertSeverity,
    getSeverityForUsedPercent,
    getThemePalette,
    groupBucketsForDetailedView,
    inferBucketWindowSeconds,
    normalizeSparklinePoints,
    normalizeStatusReport,
    posixShellQuote,
    resolveEffectivePopoverLayout,
    slugifyAccountId,
    sortProvidersByOrder,
    summarizeOverflowProviders,
    tokenizeLoginCommand,
} from '../extension/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STYLESHEET_PATH = path.join(REPO_ROOT, 'extension', 'stylesheet.css');

// ---------------------------------------------------------------------------
// Helpers for WCAG 2.1 relative luminance & CSS rule contrast verification
// ---------------------------------------------------------------------------

function parseCssColor(raw) {
    const str = String(raw || '').trim();
    const hexMatch = /^#([0-9a-fA-F]{6})$/.exec(str);
    if (hexMatch) {
        const hex = hexMatch[1];
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1,
        };
    }
    const rgbaMatch = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(str);
    if (rgbaMatch) {
        return {
            r: Number(rgbaMatch[1]),
            g: Number(rgbaMatch[2]),
            b: Number(rgbaMatch[3]),
            a: rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1,
        };
    }
    throw new Error(`Unsupported CSS color literal: ${raw}`);
}

function compositeOver(fg, bg) {
    const alpha = fg.a + bg.a * (1 - fg.a);
    if (alpha <= 0)
        return {r: 0, g: 0, b: 0, a: 0};
    return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / alpha,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / alpha,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / alpha,
        a: alpha,
    };
}

function channelToLinear(c8) {
    const s = c8 / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb) {
    return (
        0.2126 * channelToLinear(rgb.r) +
        0.7152 * channelToLinear(rgb.g) +
        0.0722 * channelToLinear(rgb.b)
    );
}

function contrastRatio(fgRaw, bgRaw, baseSurfaceRaw = null) {
    let bg = typeof bgRaw === 'string' ? parseCssColor(bgRaw) : bgRaw;
    if (baseSurfaceRaw && bg.a < 1) {
        const base = typeof baseSurfaceRaw === 'string' ? parseCssColor(baseSurfaceRaw) : baseSurfaceRaw;
        bg = compositeOver(bg, base);
    }
    let fg = typeof fgRaw === 'string' ? parseCssColor(fgRaw) : fgRaw;
    if (fg.a < 1)
        fg = compositeOver(fg, bg);

    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

function extractThemeColorMap(cssText, themeSelectorPrefix) {
    const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    const ruleRegex = /([^{}]+)\{([^{}]+)\}/g;
    const propsBySelector = new Map();
    let match;

    while ((match = ruleRegex.exec(clean)) !== null) {
        const rawSelectors = match[1].split(',').map(s => s.trim()).filter(Boolean);
        const body = match[2];
        const props = {};
        for (const decl of body.split(';')) {
            const colon = decl.indexOf(':');
            if (colon <= 0)
                continue;
            const k = decl.slice(0, colon).trim();
            const v = decl.slice(colon + 1).trim();
            if (k && v)
                props[k] = v;
        }

        for (const sel of rawSelectors) {
            if (sel === themeSelectorPrefix) {
                const prev = propsBySelector.get('__root__') ?? {};
                propsBySelector.set('__root__', {...prev, ...props});
            } else if (sel.startsWith(`${themeSelectorPrefix} `)) {
                const sub = sel.slice(themeSelectorPrefix.length + 1).trim();
                const prev = propsBySelector.get(sub) ?? {};
                propsBySelector.set(sub, {...prev, ...props});
            }
        }
    }

    return propsBySelector;
}

// ---------------------------------------------------------------------------
// 1. 10 Canonical Providers, Default Top-5 Priority & 24 Curated Themes
// ---------------------------------------------------------------------------

describe('10 Canonical Providers, Top-5 Priority & 24 Theme Contracts', () => {
    it('exports all 10 canonical providers in exact default priority order and top-5 visibility', () => {
        assert.deepEqual(DEFAULT_PROVIDER_ORDER, [
            'claude',
            'codex',
            'grok',
            'cursor',
            'agy',
            'openrouter',
            'copilot',
            'gemini',
            'windsurf',
            'deepseek',
        ]);
        assert.deepEqual(DEFAULT_HIDDEN_PROVIDERS, [
            'openrouter',
            'copilot',
            'gemini',
            'windsurf',
            'deepseek',
        ]);
        assert.equal(Object.isFrozen(DEFAULT_PROVIDER_ORDER), true);
        assert.equal(Object.isFrozen(DEFAULT_HIDDEN_PROVIDERS), true);
        assert.deepEqual(
            CANONICAL_PROVIDERS.map(p => p.id),
            [...DEFAULT_PROVIDER_ORDER]
        );
    });

    it('exposes exact OpenRouter, Windsurf, DeepSeek, Copilot, and Gemini metadata', () => {
        assert.deepEqual(PROVIDER_BY_ID.openrouter, {
            id: 'openrouter',
            displayName: 'OpenRouter',
            iconName: 'provider-openrouter',
            shortCode: 'OR',
            defaultLoginCommand: 'openrouter',
            locationHint: '~/.config/openrouter/api_key',
            dashboardUrl: 'https://openrouter.ai/activity',
        });

        assert.deepEqual(PROVIDER_BY_ID.windsurf, {
            id: 'windsurf',
            displayName: 'Windsurf',
            iconName: 'provider-windsurf',
            shortCode: 'WS',
            defaultLoginCommand: 'windsurf',
            locationHint: '~/.config/Windsurf/User/globalStorage/state.vscdb',
            dashboardUrl: 'https://windsurf.com/subscription',
        });

        assert.deepEqual(PROVIDER_BY_ID.deepseek, {
            id: 'deepseek',
            displayName: 'DeepSeek',
            iconName: 'provider-deepseek',
            shortCode: 'DS',
            defaultLoginCommand: 'deepseek',
            locationHint: '~/.config/deepseek/api_key',
            dashboardUrl: 'https://platform.deepseek.com/usage',
        });

        assert.equal(PROVIDER_BY_ID.copilot.displayName, 'GitHub Copilot');
        assert.equal(PROVIDER_BY_ID.copilot.iconName, 'provider-copilot');
        assert.equal(PROVIDER_BY_ID.copilot.defaultLoginCommand, 'gh auth login');
        assert.equal(PROVIDER_BY_ID.copilot.dashboardUrl, 'https://github.com/settings/copilot');

        assert.equal(PROVIDER_BY_ID.gemini.displayName, 'Gemini CLI');
        assert.equal(PROVIDER_BY_ID.gemini.iconName, 'provider-gemini');
        assert.equal(PROVIDER_BY_ID.gemini.defaultLoginCommand, 'gemini');
        assert.equal(PROVIDER_BY_ID.gemini.dashboardUrl, 'https://aistudio.google.com/');
    });

    it('defines complete non-empty metadata for every canonical provider', () => {
        for (const id of DEFAULT_PROVIDER_ORDER) {
            const meta = PROVIDER_BY_ID[id];
            assert.ok(meta, `Missing PROVIDER_BY_ID.${id}`);
            assert.equal(typeof meta.displayName, 'string');
            assert.ok(meta.displayName.length > 0);
            assert.match(meta.iconName, /^provider-[a-z]+$/);
            assert.equal(typeof meta.shortCode, 'string');
            assert.equal(meta.shortCode.length, 2);
            assert.equal(typeof meta.defaultLoginCommand, 'string');
            assert.ok(meta.defaultLoginCommand.length > 0);
            assert.match(meta.dashboardUrl, /^https:\/\//);
        }
    });

    it('returns all 9 canonical credential watch paths and deduplicates custom XDG_CONFIG_HOME', () => {
        const standard = defaultCredentialWatchPaths('/home/alice', '/home/alice/.config');
        assert.deepEqual(standard, [
            '/home/alice/.claude/.credentials.json',
            '/home/alice/.codex/auth.json',
            '/home/alice/.grok/auth.json',
            '/home/alice/.config/gh/hosts.yml',
            '/home/alice/.config/github-copilot/hosts.json',
            '/home/alice/.gemini/oauth_creds.json',
            '/home/alice/.config/openrouter',
            '/home/alice/.config/Windsurf/User/globalStorage/state.vscdb',
            '/home/alice/.config/deepseek',
        ]);

        const customXdg = defaultCredentialWatchPaths('/home/alice/', '/home/alice/.xdg-cfg/');
        assert.equal(customXdg.length, 14);
        assert.ok(customXdg.includes('/home/alice/.xdg-cfg/openrouter'));
        assert.ok(customXdg.includes('/home/alice/.xdg-cfg/Windsurf/User/globalStorage/state.vscdb'));
        assert.ok(customXdg.includes('/home/alice/.xdg-cfg/deepseek'));
        assert.deepEqual(defaultCredentialWatchPaths(''), []);
    });

    it('exposes all 24 curated theme presets + system-light across glass, light, and dark categories', () => {
        assert.equal(THEME_PRESETS.length, 24);
        const expectedIds = [
            'system',
            'liquid-glass',
            'liquid-glass-light',
            'catppuccin-latte',
            'flexoki-light',
            'rose-pine-dawn',
            'daylight-white',
            'lumon',
            'midnight-slate',
            'tokyo-night',
            'catppuccin',
            'everforest',
            'gruvbox',
            'kanagawa',
            'matte-black',
            'nord',
            'osaka-jade',
            'ristretto',
            'rose-pine',
            'ethereal',
            'hackerman',
            'miasma',
            'vantablack',
            'retro-82',
        ];
        assert.deepEqual(THEME_PRESETS.map(t => t.id), expectedIds);
        assert.equal(THEME_PRESETS.filter(t => t.category === 'glass').length, 3);
        assert.equal(THEME_PRESETS.filter(t => t.category === 'light').length, 5);
        assert.equal(THEME_PRESETS.filter(t => t.category === 'dark').length, 16);

        assert.deepEqual(QUICK_THEME_IDS, [
            'midnight-slate',
            'liquid-glass',
            'catppuccin-latte',
            'tokyo-night',
        ]);
        assert.deepEqual(THEME_CATEGORIES.map(c => c.id), ['all', 'dark', 'light', 'glass']);
        assert.deepEqual(POPOVER_LAYOUTS.map(l => l.id), ['list', 'auto-grid', 'grid']);

        for (const id of [...expectedIds, 'system-light']) {
            const p = getThemePalette(id);
            assert.equal(p.id, id);
            assert.match(p.swatchHex, /^#[0-9a-fA-F]{6}$/);
            assert.match(p.accentHex, /^#[0-9a-fA-F]{6}$/);
            assert.match(p.bgHex, /^#[0-9a-fA-F]{6}$/);
            assert.match(p.fgHex, /^#[0-9a-fA-F]{6}$/);
            assert.match(p.mutedHex, /^#[0-9a-fA-F]{6}$/);
            for (const rgba of [p.trackRgba, p.heroTrackRgba, p.okFillRgba, p.warnFillRgba, p.critFillRgba]) {
                assert.equal(rgba.length, 4);
                for (const c of rgba)
                    assert.ok(c >= 0 && c <= 1, `Channel out of [0,1] in ${id}: ${c}`);
            }
        }
        assert.equal(SYSTEM_LIGHT_PALETTE.isLight, true);
        assert.equal(getThemePalette('non-existent').id, 'midnight-slate');
        assert.deepEqual(getBarFillRgba('critical', 'nord'), THEME_BY_ID.nord.critFillRgba);
        assert.deepEqual(getBarFillRgba('warning', 'gruvbox'), THEME_BY_ID.gruvbox.warnFillRgba);
        assert.deepEqual(getBarFillRgba('normal', 'catppuccin'), THEME_BY_ID.catppuccin.okFillRgba);
    });
});

// ---------------------------------------------------------------------------
// 2. Custom `provider-order` Sorting, Visibility, Layout & Progressive Disclosure
// ---------------------------------------------------------------------------

describe('sortProvidersByOrder, filterVisibleProviders, Layout & Overflow Disclosure', () => {
    const sampleProviders = DEFAULT_PROVIDER_ORDER.map(id => ({
        id,
        display_name: PROVIDER_BY_ID[id].displayName,
    }));

    it('preserves canonical 10-provider order and filters DEFAULT_HIDDEN_PROVIDERS to top 5', () => {
        const sorted = sortProvidersByOrder(sampleProviders, DEFAULT_PROVIDER_ORDER);
        assert.deepEqual(sorted.map(p => p.id), [...DEFAULT_PROVIDER_ORDER]);
        assert.notEqual(sorted, sampleProviders);

        const defaultVisible = filterVisibleProviders(sorted, DEFAULT_HIDDEN_PROVIDERS);
        assert.deepEqual(defaultVisible.map(p => p.id), [
            'claude',
            'codex',
            'grok',
            'cursor',
            'agy',
        ]);
    });

    it('appends omitted canonical providers in canonical order when upgrading from 5 or 7 providers', () => {
        const legacySevenOrder = ['codex', 'claude', 'cursor', 'grok', 'agy', 'copilot', 'gemini'];
        const sorted = sortProvidersByOrder(sampleProviders, legacySevenOrder);
        assert.deepEqual(sorted.map(p => p.id), [
            'codex',
            'claude',
            'cursor',
            'grok',
            'agy',
            'copilot',
            'gemini',
            'openrouter',
            'windsurf',
            'deepseek',
        ]);
    });

    it('deduplicates repeated IDs, ignores unknown order entries, and keeps extra report providers', () => {
        const withExperimental = [...sampleProviders, {id: 'custom-lab', display_name: 'Custom Lab'}];
        const messyOrder = ['deepseek', 'deepseek', 'unknown-id', 'claude', '', null];
        const sorted = sortProvidersByOrder(withExperimental, messyOrder);
        assert.deepEqual(sorted.map(p => p.id), [
            'deepseek',
            'claude',
            'codex',
            'grok',
            'cursor',
            'agy',
            'openrouter',
            'copilot',
            'gemini',
            'windsurf',
            'custom-lab',
        ]);
    });

    it('resolves list vs 2-column wide Bento layout across list, auto-grid, and grid modes', () => {
        assert.equal(resolveEffectivePopoverLayout('list', 10, 2560), 'list');
        assert.equal(resolveEffectivePopoverLayout('grid', 1, 1920), 'list');
        assert.equal(resolveEffectivePopoverLayout('grid', 2, 1920), 'grid');
        assert.equal(resolveEffectivePopoverLayout('auto-grid', 5, 1920), 'list');
        assert.equal(resolveEffectivePopoverLayout('auto-grid', 6, 1920), 'grid');
        assert.equal(resolveEffectivePopoverLayout('auto-grid', 8, 720), 'list');
    });

    it('summarizes overflow providers (6+) with preview names and semantic alert detection', () => {
        const overflow = [
            {id: 'openrouter', display_name: 'OpenRouter', primary_used_percent: 32, accounts: []},
            {id: 'copilot', display_name: 'GitHub Copilot', primary_used_percent: 40, accounts: []},
            {id: 'gemini', display_name: 'Gemini CLI', primary_used_percent: 12, accounts: []},
        ];
        const collapsed = summarizeOverflowProviders(overflow, false);
        assert.equal(collapsed.count, 3);
        assert.equal(collapsed.hasAlert, false);
        assert.equal(collapsed.alertSeverity, 'normal');
        assert.equal(collapsed.label, 'Show 3 more agents (OpenRouter · Copilot…) ▾');

        const expanded = summarizeOverflowProviders(overflow, true);
        assert.equal(expanded.label, 'Show fewer ▴');

        // Critical usage in 7th provider surfaces critical alert
        const withCritical = [
            overflow[0],
            {id: 'deepseek', display_name: 'DeepSeek', primary_used_percent: 94, accounts: []},
        ];
        const critSummary = summarizeOverflowProviders(withCritical, false);
        assert.equal(critSummary.hasAlert, true);
        assert.equal(critSummary.alertSeverity, 'critical');
        assert.equal(critSummary.label, 'Show 2 more agents (OpenRouter · DeepSeek) ▾');

        // Signed-out account or error state surfaces warning alert
        assert.equal(
            getProviderAlertSeverity({
                id: 'windsurf',
                accounts: [{id: 'w1', is_active: true, state: 'signed_out', buckets: []}],
            }),
            'warning'
        );
        assert.equal(
            getProviderAlertSeverity({
                id: 'openrouter',
                accounts: [{id: 'o1', is_active: true, state: 'error', error: 'HTTP 401', buckets: []}],
            }),
            'warning'
        );
    });
});

// ---------------------------------------------------------------------------
// 3. 7-Day Sparkline Normalization & 1-Click Clipboard Summary
// ---------------------------------------------------------------------------

describe('normalizeSparklinePoints & formatClipboardSummary', () => {
    const NOW = 1_760_000_000;

    it('returns null when fewer than 2 valid sparkline timestamps exist', () => {
        assert.equal(normalizeSparklinePoints(null), null);
        assert.equal(normalizeSparklinePoints([]), null);
        assert.equal(normalizeSparklinePoints([{ts: NOW, used: 20}]), null);
        assert.equal(
            normalizeSparklinePoints([
                {ts: NOW, used: 20},
                {ts: NOW, used: 35},
            ]),
            null
        );
    });

    it('sorts 7-day sparkline points, normalizes coordinates, and respects used vs remaining mode', () => {
        const raw = [
            {ts: NOW, used: 82},
            {ts: NOW - 6 * 86_400, used: 30},
            {ts: NOW - 3 * 86_400, used: 55},
        ];

        const usedSeries = normalizeSparklinePoints(raw, 'used');
        assert.ok(usedSeries);
        assert.equal(usedSeries.points.length, 3);
        assert.equal(usedSeries.points[0].used, 30);
        assert.equal(usedSeries.points[0].xNorm, 0);
        assert.ok(Math.abs(usedSeries.points[0].yNorm - 0.70) < 1e-6);
        assert.equal(usedSeries.points[2].used, 82);
        assert.equal(usedSeries.points[2].xNorm, 1);
        assert.ok(Math.abs(usedSeries.points[2].yNorm - 0.18) < 1e-6);
        assert.equal(usedSeries.deltaDisplay, 52);
        assert.equal(usedSeries.severity, 'warning');
        assert.equal(usedSeries.summaryText, '82% used (+52% / 6d)');

        const remSeries = normalizeSparklinePoints(raw, 'remaining');
        assert.ok(remSeries);
        assert.equal(remSeries.firstDisplay, 70);
        assert.equal(remSeries.latestDisplay, 18);
        assert.equal(remSeries.deltaDisplay, -52);
        assert.equal(remSeries.severity, 'warning');
        assert.equal(remSeries.summaryText, '18% left (-52% / 6d)');
    });

    it('formats plain-text clipboard summaries cleanly in both % used and % remaining modes', () => {
        assert.equal(
            formatClipboardSummary([], 'used', NOW),
            'AI Agent Usage: No active AI agents detected'
        );

        const providers = [
            {
                id: 'claude',
                display_name: 'Claude',
                plan_badge: 'Max 20x',
                accounts: [
                    {
                        id: 'claude:default',
                        is_active: true,
                        state: 'active_ok',
                        buckets: [
                            {
                                id: '5h',
                                label: '5-Hour',
                                used_percent: 42,
                                remaining_percent: 58,
                                resets_at_epoch: NOW + 7_200,
                            },
                            {
                                id: 'wk',
                                label: 'Weekly',
                                used_percent: 61,
                                remaining_percent: 39,
                                resets_at_epoch: NOW + 172_800,
                            },
                        ],
                    },
                ],
            },
            {
                id: 'openrouter',
                display_name: 'OpenRouter',
                accounts: [
                    {
                        id: 'openrouter:default',
                        is_active: true,
                        state: 'active_ok',
                        buckets: [],
                        credits: {label: 'Balance', balance_dollars: 18.4},
                    },
                ],
            },
            {
                id: 'deepseek',
                display_name: 'DeepSeek',
                accounts: [
                    {
                        id: 'deepseek:default',
                        is_active: true,
                        state: 'signed_out',
                        buckets: [],
                    },
                ],
            },
        ];

        const usedText = formatClipboardSummary(providers, 'used', NOW);
        assert.equal(
            usedText,
            [
                'AI Agent Usage (% used)',
                '- Claude (Max 20x): 5-Hour 42% used (resets in 2h 0m) · Weekly 61% used (resets in 2d 0h)',
                '- OpenRouter: Balance: $18.40 available',
                '- DeepSeek: Signed out',
            ].join('\n')
        );

        const remText = formatClipboardSummary(providers, 'remaining', NOW);
        assert.match(remText, /^AI Agent Usage \(% remaining\)/);
        assert.match(remText, /5-Hour 58% left/);
        assert.match(remText, /Weekly 39% left/);
    });
});

// ---------------------------------------------------------------------------
// 4. Burn-Rate / Pace Indicator (`inferBucketWindowSeconds` & `computeBucketPace`)
// ---------------------------------------------------------------------------

describe('inferBucketWindowSeconds & computeBucketPace', () => {
    const NOW = 1_760_000_000;

    it('prefers explicit bucket.window_seconds from Rust UsageBucket', () => {
        assert.equal(inferBucketWindowSeconds({id: 'custom', window_seconds: 43_200}), 43_200);
        assert.equal(inferBucketWindowSeconds({id: 'wk', window_seconds: 120_000}), 120_000);
    });

    it('infers canonical window durations from bucket id, short_label, and label', () => {
        assert.equal(inferBucketWindowSeconds({id: 'session_5h', short_label: '5h'}), 18_000);
        assert.equal(inferBucketWindowSeconds({id: 'gemini_daily', short_label: '24h'}), 86_400);
        assert.equal(inferBucketWindowSeconds({label: 'Daily Flash'}), 86_400);
        assert.equal(inferBucketWindowSeconds({short_label: 'wk'}), 604_800);
        assert.equal(inferBucketWindowSeconds({label: '7d rolling'}), 604_800);
        assert.equal(inferBucketWindowSeconds({short_label: '31d'}), 2_678_400);
        assert.equal(inferBucketWindowSeconds({short_label: 'premium', label: 'Premium Requests'}), 2_678_400);
        assert.equal(inferBucketWindowSeconds({id: 'mystery', short_label: 'credits'}), 0);
    });

    it('classifies comfortable, on-track, elevated, and over-budget pace accurately', () => {
        assert.equal(
            computeBucketPace({short_label: '5h', used_percent: 20, resets_at_epoch: NOW + 17_460}, NOW),
            null
        );

        const comfortable = computeBucketPace({
            short_label: 'wk',
            used_percent: 19,
            resets_at_epoch: NOW + 453_600,
        }, NOW);
        assert.equal(comfortable?.state, 'under');
        assert.equal(comfortable?.severity, 'normal');

        const onTrack = computeBucketPace({
            short_label: '5h',
            used_percent: 44,
            resets_at_epoch: NOW + 9_000,
        }, NOW);
        assert.equal(onTrack?.state, 'on_track');

        const elevated = computeBucketPace({
            short_label: '24h',
            used_percent: 60,
            resets_at_epoch: NOW + 43_200,
        }, NOW);
        assert.equal(elevated?.state, 'elevated');
        assert.equal(elevated?.severity, 'warning');

        const over = computeBucketPace({
            short_label: 'premium',
            used_percent: 48,
            resets_at_epoch: NOW + 2_008_800,
        }, NOW);
        assert.equal(over?.state, 'over');
        assert.equal(over?.severity, 'critical');
    });
});

// ---------------------------------------------------------------------------
// 5. Report Normalization, Sparkline Preservation, Time-Decay & Panel Summary
// ---------------------------------------------------------------------------

describe('normalizeStatusReport, Labels & computePanelSummary', () => {
    const NOW = 1_760_000_000;

    it('formats bucket display labels across wk, 5h, 24h/daily, 31d, premium, and compound models', () => {
        assert.equal(formatBucketDisplayLabel({short_label: 'wk', label: 'wk'}), 'Weekly');
        assert.equal(formatBucketDisplayLabel({short_label: '5h', label: '5h'}), '5-Hour');
        assert.equal(formatBucketDisplayLabel({short_label: '24h', label: '24h'}), 'Daily');
        assert.equal(formatBucketDisplayLabel({short_label: '31d', label: '31d'}), 'Monthly');
        assert.equal(formatBucketDisplayLabel({short_label: 'premium', label: 'premium'}), 'Premium Requests');
        assert.equal(formatBucketDisplayLabel({short_label: 'Sonnet · wk', label: ''}), 'Sonnet · Weekly');
    });

    it('normalizes v2 reports across new providers, preserves sparklines, and decays expired buckets', () => {
        const raw = {
            schema_version: 2,
            updated_at_epoch: NOW - 30,
            providers: [
                {
                    id: 'openrouter',
                    active_account_id: 'openrouter:default',
                    accounts: [
                        {
                            id: 'openrouter:default',
                            label: 'API Key',
                            is_active: true,
                            state: 'active_ok',
                            sparkline: [
                                {ts: NOW - 86_400, used: 22},
                                {ts: NOW, used: 47.6},
                            ],
                            buckets: [
                                {
                                    id: '31d',
                                    short_label: '31d',
                                    is_primary: true,
                                    used_percent: 48,
                                    resets_at_epoch: NOW + 800_000,
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'gemini',
                    active_account_id: 'gemini:default',
                    accounts: [
                        {
                            id: 'gemini:default',
                            label: 'dev@example.com',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: 'daily',
                                    short_label: '24h',
                                    is_primary: true,
                                    used_percent: 91,
                                    resets_at_epoch: NOW - 10,
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const report = normalizeStatusReport(raw, NOW);
        const openrouter = report.providers[0];
        assert.equal(openrouter.display_name, 'OpenRouter');
        assert.equal(openrouter.icon_name, 'provider-openrouter');
        assert.equal(openrouter.dashboard_url, 'https://openrouter.ai/activity');
        assert.deepEqual(openrouter.accounts[0].sparkline, [
            {ts: NOW - 86_400, used: 22},
            {ts: NOW, used: 48},
        ]);

        const gemini = report.providers[1];
        assert.equal(gemini.primary_used_percent, 0);
        assert.equal(gemini.primary_remaining_percent, 100);
    });

    it('computes panel summary and helper formatters cleanly', () => {
        const report = normalizeStatusReport({
            schema_version: 2,
            providers: [
                {
                    id: 'claude',
                    accounts: [{
                        id: 'c1',
                        is_active: true,
                        state: 'active_ok',
                        buckets: [{id: 'wk', short_label: 'wk', is_primary: true, used_percent: 35}],
                    }],
                },
                {
                    id: 'windsurf',
                    accounts: [{
                        id: 'w1',
                        is_active: true,
                        state: 'active_ok',
                        buckets: [{id: '31d', short_label: '31d', is_primary: true, used_percent: 84}],
                    }],
                },
            ],
        }, NOW);

        const usedSummary = computePanelSummary(report.providers, 'used', ' · ');
        assert.equal(usedSummary.severity, 'warning');
        assert.equal(usedSummary.fullText, 'Claude: 35% · Windsurf: 84%');

        assert.equal(clampPercent(-5), 0);
        assert.equal(clampPercent(120), 100);
        assert.equal(getSeverityForUsedPercent(80), 'warning');
        assert.equal(getSeverityForUsedPercent(90), 'critical');
        assert.equal(formatBucketMetric({used_percent: 25}, 'remaining').percentText, '75%');
        assert.equal(formatResetCountdown(NOW + 9_000, NOW), 'Resets in 2h 30m');
        assert.equal(formatRelativeUpdated(NOW - 125, NOW), 'Updated 2m ago');
        assert.equal(computeBucketPace({short_label: '5h', used_percent: 50, resets_at_epoch: NOW + 9_000}, Number.NaN), null);
        assert.equal(formatCreditsSummary({balance_dollars: 14.5}), 'Credits: $14.50 available');
        assert.equal(formatCreditsSummary({label: 'Balance (CNY)', balance_dollars: 88}), 'Balance (CNY): ¥88.00 available');
        assert.equal(formatCompactAccountExtraNote({credits: {balance_dollars: 12}}, false), 'Credits: $12.00');
        assert.equal(formatCompactAccountExtraNote({credits: {label: 'Balance (CNY)', balance_dollars: 88}}, false), 'Balance (CNY): ¥88.00');
        assert.equal(groupBucketsForDetailedView([{id: 'a'}, {id: 'b'}]).length, 2);
        assert.equal(slugifyAccountId('  Work Account #2! '), 'work-account-2');
        assert.equal(buildConfigUpsertArgs({provider: 'openrouter', id: 'main', label: 'Main'})[3], 'openrouter');
    });

    function makeMultiAccountProviders() {
        return normalizeStatusReport({
            schema_version: 2,
            providers: [
                {
                    id: 'claude',
                    display_name: 'Claude',
                    icon_name: 'provider-claude',
                    active_account_id: 'claude:home',
                    accounts: [
                        {
                            id: 'claude:work',
                            label: 'work@example.com',
                            is_active: false,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: 'wk',
                                    label: 'Weekly',
                                    short_label: 'wk',
                                    is_primary: true,
                                    used_percent: 98,
                                    remaining_percent: 2,
                                    resets_at_epoch: NOW + 86_400,
                                },
                            ],
                        },
                        {
                            id: 'claude:home',
                            label: 'home@example.com',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: 'wk',
                                    label: 'Weekly',
                                    short_label: 'wk',
                                    is_primary: true,
                                    used_percent: 20,
                                    remaining_percent: 80,
                                    resets_at_epoch: NOW + 172_800,
                                },
                            ],
                        },
                    ],
                },
                {
                    id: 'codex',
                    display_name: 'Codex',
                    icon_name: 'provider-codex',
                    active_account_id: 'codex:default',
                    accounts: [
                        {
                            id: 'codex:default',
                            label: 'dev@example.com',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: 'wk',
                                    label: 'Weekly',
                                    short_label: 'wk',
                                    is_primary: true,
                                    used_percent: 41,
                                    remaining_percent: 59,
                                    resets_at_epoch: NOW + 172_800,
                                },
                            ],
                        },
                    ],
                },
            ],
        }, NOW).providers;
    }

    it('keeps active mode and compact-pills output equal to legacy behavior', () => {
        const providers = makeMultiAccountProviders();
        const defaultSummary = computePanelSummary(providers, 'used', ' | ');
        const activeCompact = computePanelSummary(providers, 'used', ' | ', {
            mode: 'active',
            panelMode: 'compact-pills',
        });

        assert.equal(defaultSummary.pills.length, 2);
        assert.equal(defaultSummary.maxUsedPercent, 41);
        assert.equal(defaultSummary.severity, 'normal');
        assert.equal(defaultSummary.fullText, 'Claude: 20% | Codex: 41%');
        assert.equal(defaultSummary.pills[0].percentText, '20%');
        assert.equal(defaultSummary.pills[1].percentText, '41%');

        assert.equal(activeCompact.pills.length, 2);
        assert.equal(activeCompact.maxUsedPercent, 41);
        assert.equal(activeCompact.severity, 'normal');
        assert.equal(activeCompact.fullText, 'Claude: 20% | Codex: 41%');
        assert.equal(activeCompact.pills[0].percentText, '20%');
        assert.equal(activeCompact.pills[0].label, '');
        assert.equal(activeCompact.pills[0].tooltip, 'home@example.com');

        assert.deepEqual(
            PANEL_MODES.map(m => m.id),
            ['icon', 'compact-pills', 'labeled-pills', 'full-text']
        );
        assert.deepEqual(
            PANEL_MODES.map(m => m.shortLabel),
            ['Icon', 'Pills', 'Labeled', 'Text']
        );
        assert.deepEqual(
            PANEL_ACCOUNT_MODES.map(m => m.id),
            ['active', 'all', 'selected']
        );
        assert.deepEqual(
            PANEL_ACCOUNT_MODES.map(m => m.shortLabel),
            ['Active', 'All', 'Selected']
        );
    });

    it('shows two Claude pills in all mode and sets severity to the worst account', () => {
        const providers = makeMultiAccountProviders();
        const allSummary = computePanelSummary(providers, 'used', ' | ', {
            mode: 'all',
        });

        assert.equal(allSummary.pills.length, 3);
        assert.equal(allSummary.maxUsedPercent, 98);
        assert.equal(allSummary.severity, 'critical');
        assert.equal(allSummary.fullText, 'Claude (work): 98% | Claude (home): 20% | Codex: 41%');

        assert.equal(allSummary.pills[0].id, 'claude::claude:work');
        assert.equal(allSummary.pills[0].percentText, '98%');
        assert.equal(allSummary.pills[0].severity, 'critical');

        assert.equal(allSummary.pills[1].id, 'claude::claude:home');
        assert.equal(allSummary.pills[1].percentText, '20%');
        assert.equal(allSummary.pills[1].severity, 'normal');

        assert.equal(allSummary.pills[2].id, 'codex::codex:default');
        assert.equal(allSummary.pills[2].percentText, '41%');
        assert.equal(allSummary.pills[2].severity, 'normal');
    });

    it('uses account tags for multi-account providers and short provider name for single-account providers in labeled-pills', () => {
        const providers = makeMultiAccountProviders();
        const entries = buildPanelEntries(providers, {mode: 'all'});
        assert.equal(entries.length, 3);

        const claudeEntries = entries.filter(e => e.providerId === 'claude');
        const codexEntries = entries.filter(e => e.providerId === 'codex');
        assert.equal(formatPanelPillLabel(claudeEntries[0], claudeEntries), 'work');
        assert.equal(formatPanelPillLabel(claudeEntries[1], claudeEntries), 'home');
        assert.equal(formatPanelPillLabel(codexEntries[0], codexEntries), 'Codex');

        const labeled = computePanelSummary(providers, 'used', ' | ', {
            mode: 'all',
            panelMode: 'labeled-pills',
        });
        assert.equal(labeled.pills[0].label, 'work');
        assert.equal(labeled.pills[1].label, 'home');
        assert.equal(labeled.pills[2].label, 'Codex');

        assert.equal(formatAccountShortTag({id: 'claude:work', label: 'work@example.com'}), 'work');
        assert.equal(formatAccountShortTag({id: 'claude:team', label: 'TeamProfileName'}), 'TeamProf');
    });

    it('gives compact-pills a tooltip and an empty text label', () => {
        const providers = makeMultiAccountProviders();
        const compact = computePanelSummary(providers, 'used', ' | ', {
            mode: 'all',
            panelMode: 'compact-pills',
        });

        assert.equal(compact.pills.length, 3);
        assert.equal(compact.pills[0].label, '');
        assert.equal(compact.pills[0].tooltip, 'work@example.com');
        assert.equal(compact.pills[1].label, '');
        assert.equal(compact.pills[1].tooltip, 'home@example.com');
        assert.equal(compact.pills[2].label, '');
        assert.equal(compact.pills[2].tooltip, 'dev@example.com');
    });

    it('falls back to the active account when a selected ID does not match an account', () => {
        const providers = makeMultiAccountProviders();
        const fallbackEntries = buildPanelEntries(providers, {
            mode: 'selected',
            accountIds: ['claude:missing'],
        });
        assert.equal(fallbackEntries.length, 2);
        assert.equal(fallbackEntries[0].accountId, 'claude:home');
        assert.equal(fallbackEntries[0].usedPercent, 20);
        assert.equal(fallbackEntries[1].accountId, 'codex:default');
        assert.equal(fallbackEntries[1].usedPercent, 41);

        const matchedSummary = computePanelSummary(providers, 'used', ' | ', {
            mode: 'selected',
            accountIds: ['claude:work'],
        });
        assert.equal(matchedSummary.pills.length, 2);
        assert.equal(matchedSummary.pills[0].id, 'claude::claude:work');
        assert.equal(matchedSummary.pills[0].percentText, '98%');
        assert.equal(matchedSummary.pills[1].id, 'codex::codex:default');
        assert.equal(matchedSummary.pills[1].percentText, '41%');

        const clipAll = formatClipboardSummary(providers, 'used', NOW, {mode: 'all'});
        assert.match(clipAll, /- Claude \(work\): Weekly 98% used/);
        assert.match(clipAll, /- Claude \(home\): Weekly 20% used/);
        assert.match(clipAll, /- Codex: Weekly 41% used/);

        // Passive cached accounts set isPassive, signed_out shows '!', and empty non-signed-out accounts are skipped
        const mixedProviders = [
            {
                id: 'claude',
                display_name: 'Claude',
                icon_name: 'provider-claude',
                active_account_id: 'claude:work',
                accounts: [
                    {
                        id: 'claude:work',
                        label: 'work@example.com',
                        is_active: true,
                        state: 'passive_cached',
                        buckets: [{id: 'wk', is_primary: true, used_percent: 33, remaining_percent: 67}],
                    },
                    {
                        id: 'claude:empty',
                        label: 'empty@example.com',
                        is_active: false,
                        state: 'active_ok',
                        buckets: [],
                    },
                    {
                        id: 'claude:out',
                        label: 'out@example.com',
                        is_active: false,
                        state: 'signed_out',
                        buckets: [],
                    },
                ],
            },
        ];
        const mixedSummary = computePanelSummary(mixedProviders, 'used', ' | ', {mode: 'all'});
        assert.equal(mixedSummary.pills.length, 2);
        assert.equal(mixedSummary.pills[0].id, 'claude::claude:work');
        assert.equal(mixedSummary.pills[0].isPassive, true);
        assert.equal(mixedSummary.pills[0].percentText, '33%');
        assert.equal(mixedSummary.pills[1].id, 'claude::claude:out');
        assert.equal(mixedSummary.pills[1].percentText, '!');
        assert.equal(mixedSummary.pills[1].severity, 'critical');
        assert.equal(mixedSummary.fullText, 'Claude (work): 33% | Claude (out): AUTH');
    });
});

// ---------------------------------------------------------------------------
// 6. Smart Quota & Reset Desktop Notifications (`evaluateQuotaNotificationStep`)
// ---------------------------------------------------------------------------

describe('evaluateQuotaNotificationStep', () => {
    const NOW = 1_760_000_000;
    const WIN_1 = NOW + 172_800;
    const WIN_2 = WIN_1 + 604_800;

    function makeSingleBucketReport(providerId, usedPercent, resetsAtEpoch = WIN_1) {
        return {
            schema_version: 2,
            updated_at_epoch: NOW,
            providers: [
                {
                    id: providerId,
                    active_account_id: `${providerId}:default`,
                    accounts: [
                        {
                            id: `${providerId}:default`,
                            label: 'Default',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: 'wk',
                                    short_label: 'wk',
                                    is_primary: true,
                                    used_percent: usedPercent,
                                    resets_at_epoch: resetsAtEpoch,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    }

    it('handles hydration baseline, warning/critical once-per-window, reset re-arming, and hidden filtering', () => {
        const states = new Map();
        assert.deepEqual(
            evaluateQuotaNotificationStep(states, makeSingleBucketReport('claude', 94, WIN_1), {
                isInitialHydration: true,
                nowEpoch: NOW,
                notifyOnWarning: true,
                notifyOnCritical: true,
            }),
            []
        );

        const s2 = new Map();
        evaluateQuotaNotificationStep(s2, makeSingleBucketReport('codex', 70, WIN_1), {
            isInitialHydration: true,
            nowEpoch: NOW,
        });
        const warnOut = evaluateQuotaNotificationStep(s2, makeSingleBucketReport('codex', 85, WIN_1), {
            nowEpoch: NOW + 60,
            notifyOnWarning: true,
        });
        assert.equal(warnOut.length, 1);
        assert.equal(warnOut[0].kind, 'warning');

        const critOut = evaluateQuotaNotificationStep(s2, makeSingleBucketReport('codex', 92, WIN_1), {
            nowEpoch: NOW + 120,
            notifyOnCritical: true,
        });
        assert.equal(critOut.length, 1);
        assert.equal(critOut[0].kind, 'critical');

        const resetOut = evaluateQuotaNotificationStep(s2, makeSingleBucketReport('codex', 0, WIN_2), {
            nowEpoch: WIN_1 + 5,
            notifyOnReset: true,
        });
        assert.equal(resetOut.length, 1);
        assert.equal(resetOut[0].kind, 'reset');

        const sHidden = new Map();
        evaluateQuotaNotificationStep(sHidden, makeSingleBucketReport('openrouter', 50, WIN_1), {
            isInitialHydration: true,
            nowEpoch: NOW,
        });
        assert.deepEqual(
            evaluateQuotaNotificationStep(sHidden, makeSingleBucketReport('openrouter', 95, WIN_1), {
                nowEpoch: NOW + 60,
                hiddenProviderIds: DEFAULT_HIDDEN_PROVIDERS,
                notifyOnCritical: true,
            }),
            []
        );
    });

    it('sends alerts for a non-active account when the panel shows that account', () => {
        function makeTwoAccountClaudeReport(workUsed, homeUsed, workReset = WIN_1) {
            return {
                schema_version: 2,
                updated_at_epoch: NOW,
                providers: [
                    {
                        id: 'claude',
                        active_account_id: 'claude:home',
                        accounts: [
                            {
                                id: 'claude:work',
                                label: 'work@example.com',
                                is_active: false,
                                state: 'active_ok',
                                buckets: [
                                    {
                                        id: 'wk',
                                        short_label: 'wk',
                                        is_primary: true,
                                        used_percent: workUsed,
                                        resets_at_epoch: workReset,
                                    },
                                ],
                            },
                            {
                                id: 'claude:home',
                                label: 'home@example.com',
                                is_active: true,
                                state: 'active_ok',
                                buckets: [
                                    {
                                        id: 'wk',
                                        short_label: 'wk',
                                        is_primary: true,
                                        used_percent: homeUsed,
                                        resets_at_epoch: WIN_1,
                                    },
                                ],
                            },
                        ],
                    },
                ],
            };
        }

        // In 'active' mode, non-active claude:work crossing 90% does not emit an alert
        const activeStates = new Map();
        evaluateQuotaNotificationStep(activeStates, makeTwoAccountClaudeReport(70, 20), {
            isInitialHydration: true,
            nowEpoch: NOW,
            mode: 'active',
        });
        assert.deepEqual(
            evaluateQuotaNotificationStep(activeStates, makeTwoAccountClaudeReport(94, 20), {
                nowEpoch: NOW + 60,
                mode: 'active',
                notifyOnCritical: true,
            }),
            []
        );

        // In 'all' mode, non-active claude:work crossing 90% emits a critical alert
        const allStates = new Map();
        evaluateQuotaNotificationStep(allStates, makeTwoAccountClaudeReport(70, 20), {
            isInitialHydration: true,
            nowEpoch: NOW,
            mode: 'all',
        });
        const allAlerts = evaluateQuotaNotificationStep(allStates, makeTwoAccountClaudeReport(94, 20), {
            nowEpoch: NOW + 60,
            mode: 'all',
            notifyOnCritical: true,
        });
        assert.equal(allAlerts.length, 1);
        assert.equal(allAlerts[0].kind, 'critical');
        assert.equal(allAlerts[0].providerId, 'claude');

        // In 'selected' mode with claude:work selected, non-active claude:work emits warning and reset alerts
        const selectedStates = new Map();
        evaluateQuotaNotificationStep(selectedStates, makeTwoAccountClaudeReport(75, 20), {
            isInitialHydration: true,
            nowEpoch: NOW,
            mode: 'selected',
            accountIds: ['claude:work'],
        });
        const selectedWarn = evaluateQuotaNotificationStep(selectedStates, makeTwoAccountClaudeReport(85, 20), {
            nowEpoch: NOW + 60,
            mode: 'selected',
            accountIds: ['claude:work'],
            notifyOnWarning: true,
        });
        assert.equal(selectedWarn.length, 1);
        assert.equal(selectedWarn[0].kind, 'warning');

        const selectedReset = evaluateQuotaNotificationStep(selectedStates, makeTwoAccountClaudeReport(0, 20, WIN_2), {
            nowEpoch: WIN_1 + 10,
            mode: 'selected',
            accountIds: ['claude:work'],
            notifyOnReset: true,
        });
        assert.equal(selectedReset.length, 1);
        assert.equal(selectedReset[0].kind, 'reset');
    });
});

// ---------------------------------------------------------------------------
// 6b. Strict Parity with Legacy `origin/main` in `'active'` Mode
// ---------------------------------------------------------------------------

function legacyFormatClipboardSummary(
    visibleProviders,
    metricMode = 'used',
    nowEpoch = Math.floor(Date.now() / 1000)
) {
    const providers = Array.isArray(visibleProviders) ? visibleProviders.filter(Boolean) : [];
    if (providers.length === 0)
        return 'AI Agent Usage: No active AI agents detected';

    const isRemaining = metricMode === 'remaining';
    const modeSuffix = isRemaining ? 'left' : 'used';
    const lines = [`AI Agent Usage (${isRemaining ? '% remaining' : '% used'})`];

    for (const prov of providers) {
        const name = prov.display_name || PROVIDER_BY_ID[prov.id]?.displayName || prov.id || 'Agent';
        const activeAcc = getActiveAccount(prov);
        const tier = prov.plan_badge || activeAcc?.plan_tier || '';
        const head = tier ? `${name} (${tier})` : name;

        if (activeAcc?.state === 'signed_out') {
            lines.push(`- ${head}: Signed out`);
            continue;
        }

        const buckets = Array.isArray(activeAcc?.buckets) ? activeAcc.buckets : [];
        if (buckets.length > 0) {
            const parts = buckets.map(b => {
                const m = formatBucketMetric(b, metricMode);
                const title = formatBucketDisplayLabel(b);
                const reset = formatResetCountdown(b.resets_at_epoch, nowEpoch, {prefix: false});
                const resetSuffix = reset && reset !== 'now' ? ` (resets in ${reset})` : '';
                return `${title} ${m.percentText} ${modeSuffix}${resetSuffix}`;
            });
            const creditsNote = formatCompactAccountExtraNote(activeAcc, Boolean(tier));
            if (creditsNote)
                parts.push(creditsNote);
            lines.push(`- ${head}: ${parts.join(' · ')}`);
            continue;
        }

        if (typeof prov.primary_used_percent === 'number') {
            const m = formatBucketMetric({
                used_percent: prov.primary_used_percent,
                remaining_percent: prov.primary_remaining_percent,
            }, metricMode);
            const reset = formatResetCountdown(prov.primary_reset_epoch, nowEpoch, {prefix: false});
            const resetSuffix = reset && reset !== 'now' ? ` (resets in ${reset})` : '';
            lines.push(`- ${head}: ${m.percentText} ${modeSuffix}${resetSuffix}`);
            continue;
        }

        const fallback = formatCreditsSummary(activeAcc?.credits) ||
            activeAcc?.extra_info ||
            activeAcc?.error ||
            activeAcc?.status_note ||
            'Idle';
        lines.push(`- ${head}: ${fallback}`);
    }

    return lines.join('\n');
}

function legacyComputePanelSummary(visibleProviders, metricMode = 'used', separator = ' | ') {
    const providers = Array.isArray(visibleProviders) ? visibleProviders : [];
    let maxUsedPercent = 0;
    let hasAuthError = false;
    const pills = [];
    const textSegments = [];

    for (const prov of providers) {
        const activeAcc = getActiveAccount(prov);
        if (activeAcc?.state === 'signed_out')
            hasAuthError = true;

        const hasPrimary = typeof prov.primary_used_percent === 'number';
        if (hasPrimary) {
            const used = clampPercent(prov.primary_used_percent);
            const rem = typeof prov.primary_remaining_percent === 'number'
                ? clampPercent(prov.primary_remaining_percent)
                : Math.max(0, 100 - used);
            const displayPercent = metricMode === 'remaining' ? rem : used;
            const itemSeverity = getSeverityForUsedPercent(used);
            maxUsedPercent = Math.max(maxUsedPercent, used);

            pills.push({
                id: prov.id,
                displayName: prov.display_name,
                iconName: prov.icon_name,
                usedPercent: used,
                displayPercent,
                percentText: `${displayPercent}%`,
                severity: itemSeverity,
            });
            textSegments.push(`${prov.display_name}: ${displayPercent}%`);
        } else if (activeAcc?.state === 'signed_out') {
            pills.push({
                id: prov.id,
                displayName: prov.display_name,
                iconName: prov.icon_name,
                usedPercent: null,
                displayPercent: null,
                percentText: '!',
                severity: 'critical',
            });
            textSegments.push(`${prov.display_name}: AUTH`);
        }
    }

    let severity = getSeverityForUsedPercent(maxUsedPercent);
    if (hasAuthError && severity === 'normal')
        severity = 'warning';
    if (hasAuthError && providers.length > 0 && pills.every(p => p.usedPercent === null))
        severity = 'critical';

    const fullText = textSegments.length > 0 ? textSegments.join(separator) : 'Agents: —';

    return {
        maxUsedPercent,
        activeCount: providers.length,
        hasAuthError,
        severity,
        pills,
        fullText,
    };
}

function legacyEvaluateQuotaNotificationStep(
    bucketStates,
    report,
    {
        isInitialHydration = false,
        nowEpoch = Math.floor(Date.now() / 1000),
        hiddenProviderIds = [],
        providerOrder = DEFAULT_PROVIDER_ORDER,
        notifyOnWarning = false,
        notifyOnCritical = true,
        notifyOnReset = true,
    } = {}
) {
    if (!(bucketStates instanceof Map) || !report || typeof report !== 'object')
        return [];

    const normalized = normalizeStatusReport(report, nowEpoch);
    const allProviders = sortProvidersByOrder(normalized.providers ?? [], providerOrder);
    const visibleSet = new Set(
        filterVisibleProviders(allProviders, hiddenProviderIds).map(p => p.id)
    );

    const emitted = [];

    for (const prov of allProviders) {
        const accounts = Array.isArray(prov?.accounts) ? prov.accounts : [];
        const activeAcc = getActiveAccount(prov);

        for (const acc of accounts) {
            if (!acc || acc.state === 'signed_out')
                continue;

            const primaryBucket =
                acc.buckets?.find(b => b.is_primary) ?? acc.buckets?.[0] ?? null;
            if (!primaryBucket)
                continue;

            const bucketId = primaryBucket.id || primaryBucket.short_label || 'primary';
            const key = `${prov.id}::${acc.id || 'default'}::${bucketId}`;
            const usedPercent = clampPercent(primaryBucket.used_percent ?? 0);
            const resetsAtEpoch =
                typeof primaryBucket.resets_at_epoch === 'number' &&
                Number.isFinite(primaryBucket.resets_at_epoch) &&
                primaryBucket.resets_at_epoch > 0
                    ? primaryBucket.resets_at_epoch
                    : null;
            const windowToken = resetsAtEpoch !== null ? String(resetsAtEpoch) : 'static';

            const isTargetActive = activeAcc === acc && visibleSet.has(prov.id);
            const prev = bucketStates.get(key);

            if (isInitialHydration || !prev) {
                bucketStates.set(key, {
                    usedPercent,
                    resetsAtEpoch,
                    notifiedWarningWindow: usedPercent >= 80 ? windowToken : null,
                    notifiedCriticalWindow: usedPercent >= 90 ? windowToken : null,
                });
                continue;
            }

            let notifiedWarningWindow = prev.notifiedWarningWindow ?? null;
            let notifiedCriticalWindow = prev.notifiedCriticalWindow ?? null;

            const hasPrevReset =
                typeof prev.resetsAtEpoch === 'number' && prev.resetsAtEpoch > 0;
            const hasCurrReset = resetsAtEpoch !== null;
            const resetByClock = hasPrevReset && nowEpoch >= (prev.resetsAtEpoch - 60);
            const resetByNewWindow =
                hasPrevReset &&
                hasCurrReset &&
                resetsAtEpoch > (prev.resetsAtEpoch + 60);

            if (hasPrevReset && hasCurrReset && resetsAtEpoch > (prev.resetsAtEpoch + 60)) {
                notifiedWarningWindow = null;
                notifiedCriticalWindow = null;
            }

            const bucketLabel = formatBucketDisplayLabel(primaryBucket);

            if (prev.usedPercent >= 80 && usedPercent < 20 && (resetByClock || resetByNewWindow)) {
                notifiedWarningWindow = null;
                notifiedCriticalWindow = null;
                if (isTargetActive && notifyOnReset) {
                    emitted.push({
                        kind: 'reset',
                        providerId: prov.id,
                        title: `${prov.display_name} Quota Reset`,
                        body: `${bucketLabel} quota is fresh again (${usedPercent}% used)`,
                        urgency: 'normal',
                    });
                }
            } else if (prev.usedPercent < 90 && usedPercent >= 90) {
                if (isTargetActive && notifiedCriticalWindow !== windowToken) {
                    notifiedCriticalWindow = windowToken;
                    notifiedWarningWindow = windowToken;
                    if (notifyOnCritical) {
                        const countdown = formatResetCountdown(resetsAtEpoch, nowEpoch, {
                            prefix: false,
                        });
                        const suffix =
                            countdown && countdown !== 'now' ? ` (resets in ${countdown})` : '';
                        emitted.push({
                            kind: 'critical',
                            providerId: prov.id,
                            title: `${prov.display_name} Quota Critical (${usedPercent}%)`,
                            body: `${bucketLabel} usage reached ${usedPercent}%${suffix}`,
                            urgency: 'critical',
                        });
                    }
                }
            } else if (prev.usedPercent < 80 && usedPercent >= 80 && usedPercent < 90) {
                if (isTargetActive && notifiedWarningWindow !== windowToken) {
                    notifiedWarningWindow = windowToken;
                    if (notifyOnWarning) {
                        const countdown = formatResetCountdown(resetsAtEpoch, nowEpoch, {
                            prefix: false,
                        });
                        const suffix =
                            countdown && countdown !== 'now' ? ` (resets in ${countdown})` : '';
                        emitted.push({
                            kind: 'warning',
                            providerId: prov.id,
                            title: `${prov.display_name} Quota Warning`,
                            body: `${bucketLabel} usage reached ${usedPercent}%${suffix}`,
                            urgency: 'normal',
                        });
                    }
                }
            }

            bucketStates.set(key, {
                usedPercent,
                resetsAtEpoch,
                notifiedWarningWindow,
                notifiedCriticalWindow,
            });
        }
    }

    return emitted;
}

function projectSummaryForComparison(summary) {
    return {
        maxUsedPercent: summary.maxUsedPercent,
        severity: summary.severity,
        fullText: summary.fullText,
        pillsLength: summary.pills.length,
        pills: summary.pills.map(p => ({
            displayName: p.displayName,
            iconName: p.iconName,
            usedPercent: p.usedPercent,
            displayPercent: p.displayPercent,
            percentText: p.percentText,
            severity: p.severity,
        })),
    };
}

describe('Active mode parity with legacy main implementation', () => {
    const NOW = 1_760_000_000;
    const WIN_1 = NOW + 172_800;
    const WIN_2 = WIN_1 + 604_800;

    function buildParityReport({
        errorUsed = 72,
        passiveUsed = 33,
        secondActiveUsed = 64,
        fallbackActiveUsed = 81,
        resetEpoch = WIN_1,
    } = {}) {
        return {
            schema_version: 2,
            updated_at_epoch: NOW,
            providers: [
                // 1. Active account that is signed_out
                {
                    id: 'claude',
                    display_name: 'Claude',
                    icon_name: 'provider-claude',
                    plan_badge: 'Max 20x',
                    active_account_id: 'claude:out',
                    primary_used_percent: null,
                    primary_remaining_percent: null,
                    accounts: [
                        {
                            id: 'claude:out',
                            label: 'out@example.com',
                            plan_tier: 'Pro',
                            is_active: true,
                            state: 'signed_out',
                            buckets: [],
                        },
                    ],
                },
                // 2. Provider with accounts: [] and a primary_used_percent
                {
                    id: 'codex',
                    display_name: 'Codex',
                    icon_name: 'provider-codex',
                    plan_badge: 'Plus',
                    primary_used_percent: 42,
                    primary_remaining_percent: 58,
                    primary_reset_epoch: resetEpoch,
                    accounts: [],
                },
                // 3. Active account in error state with buckets (and distinct plan_badge vs plan_tier)
                {
                    id: 'grok',
                    display_name: 'Grok',
                    icon_name: 'provider-grok',
                    plan_badge: 'SuperGrok',
                    active_account_id: 'grok:err',
                    primary_used_percent: null,
                    primary_remaining_percent: null,
                    accounts: [
                        {
                            id: 'grok:err',
                            label: 'err@example.com',
                            plan_tier: 'Basic',
                            is_active: true,
                            state: 'error',
                            error: 'HTTP 502',
                            buckets: [
                                {
                                    id: 'wk',
                                    label: 'Weekly',
                                    short_label: 'wk',
                                    is_primary: true,
                                    used_percent: errorUsed,
                                    remaining_percent: 100 - errorUsed,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                    ],
                },
                // 4. A passive_cached active account
                {
                    id: 'cursor',
                    display_name: 'Cursor',
                    icon_name: 'provider-cursor',
                    active_account_id: 'cursor:passive',
                    primary_used_percent: passiveUsed,
                    primary_remaining_percent: 100 - passiveUsed,
                    primary_reset_epoch: resetEpoch,
                    accounts: [
                        {
                            id: 'cursor:passive',
                            label: 'passive@example.com',
                            plan_tier: 'Pro',
                            is_active: true,
                            state: 'passive_cached',
                            is_stale: true,
                            buckets: [
                                {
                                    id: '31d',
                                    label: 'Monthly',
                                    short_label: '31d',
                                    is_primary: true,
                                    used_percent: passiveUsed,
                                    remaining_percent: 100 - passiveUsed,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                    ],
                },
                // 5. A rate_limited account with no buckets
                {
                    id: 'agy',
                    display_name: 'Antigravity',
                    icon_name: 'provider-agy',
                    active_account_id: 'agy:rl',
                    primary_used_percent: null,
                    primary_remaining_percent: null,
                    accounts: [
                        {
                            id: 'agy:rl',
                            label: 'rl@example.com',
                            is_active: true,
                            state: 'rate_limited',
                            status_note: 'HTTP 429 backoff',
                            buckets: [],
                        },
                    ],
                },
                // 6. A hidden provider
                {
                    id: 'openrouter',
                    display_name: 'OpenRouter',
                    icon_name: 'provider-openrouter',
                    active_account_id: 'openrouter:main',
                    primary_used_percent: 95,
                    primary_remaining_percent: 5,
                    primary_reset_epoch: resetEpoch,
                    accounts: [
                        {
                            id: 'openrouter:main',
                            label: 'router@example.com',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: '31d',
                                    label: 'Monthly',
                                    short_label: '31d',
                                    is_primary: true,
                                    used_percent: 95,
                                    remaining_percent: 5,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                    ],
                },
                // 7. Two accounts on one provider where the second account is active
                {
                    id: 'copilot',
                    display_name: 'GitHub Copilot',
                    icon_name: 'provider-copilot',
                    plan_badge: 'Enterprise',
                    active_account_id: 'copilot:second',
                    primary_used_percent: secondActiveUsed,
                    primary_remaining_percent: 100 - secondActiveUsed,
                    primary_reset_epoch: resetEpoch,
                    accounts: [
                        {
                            id: 'copilot:first',
                            label: 'first@example.com',
                            plan_tier: 'Free',
                            is_active: false,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: '31d',
                                    label: 'Premium Requests',
                                    short_label: '31d',
                                    is_primary: true,
                                    used_percent: 15,
                                    remaining_percent: 85,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                        {
                            id: 'copilot:second',
                            label: 'second@example.com',
                            plan_tier: 'Pro+',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: '31d',
                                    label: 'Premium Requests',
                                    short_label: '31d',
                                    is_primary: true,
                                    used_percent: secondActiveUsed,
                                    remaining_percent: 100 - secondActiveUsed,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                    ],
                },
                // 8. A provider with an active_account_id that does not agree with an account
                {
                    id: 'gemini',
                    display_name: 'Gemini CLI',
                    icon_name: 'provider-gemini',
                    active_account_id: 'gemini:unknown-id',
                    primary_used_percent: fallbackActiveUsed,
                    primary_remaining_percent: 100 - fallbackActiveUsed,
                    primary_reset_epoch: resetEpoch,
                    accounts: [
                        {
                            id: 'gemini:first',
                            label: 'first@example.com',
                            is_active: false,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: '24h',
                                    label: 'Daily',
                                    short_label: '24h',
                                    is_primary: true,
                                    used_percent: 12,
                                    remaining_percent: 88,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                        {
                            id: 'gemini:second',
                            label: 'second@example.com',
                            is_active: true,
                            state: 'active_ok',
                            buckets: [
                                {
                                    id: '24h',
                                    label: 'Daily',
                                    short_label: '24h',
                                    is_primary: true,
                                    used_percent: fallbackActiveUsed,
                                    remaining_percent: 100 - fallbackActiveUsed,
                                    resets_at_epoch: resetEpoch,
                                },
                            ],
                        },
                    ],
                },
            ],
        };
    }

    it('matches legacy computePanelSummary and formatClipboardSummary across all fixture combinations in used and remaining modes', () => {
        const rawReport = buildParityReport();
        const normalized = normalizeStatusReport(rawReport, NOW);
        const hiddenIds = ['openrouter'];
        const visibleRaw = filterVisibleProviders(rawReport.providers, hiddenIds);
        const visibleNormalized = filterVisibleProviders(normalized.providers, hiddenIds);

        for (const providers of [visibleRaw, visibleNormalized]) {
            for (const metricMode of ['used', 'remaining']) {
                const legacySummary = legacyComputePanelSummary(providers, metricMode, ' | ');
                const newSummary = computePanelSummary(providers, metricMode, ' | ');

                assert.deepEqual(
                    projectSummaryForComparison(newSummary),
                    projectSummaryForComparison(legacySummary)
                );
                for (let i = 0; i < legacySummary.pills.length; i++)
                    assert.equal(newSummary.pills[i].providerId, legacySummary.pills[i].id);

                const legacyClip = legacyFormatClipboardSummary(providers, metricMode, NOW);
                const newClip = formatClipboardSummary(providers, metricMode, NOW);
                assert.deepEqual(newClip, legacyClip);
            }
        }
    });

    it('matches legacy evaluateQuotaNotificationStep alerts and bucketStates across a 3-report sequence', () => {
        const hiddenIds = ['openrouter'];
        const step1Report = buildParityReport({
            errorUsed: 72,
            passiveUsed: 33,
            secondActiveUsed: 64,
            fallbackActiveUsed: 78,
            resetEpoch: WIN_1,
        });
        const step2Report = buildParityReport({
            errorUsed: 91,
            passiveUsed: 84,
            secondActiveUsed: 93,
            fallbackActiveUsed: 85,
            resetEpoch: WIN_1,
        });
        const step3Report = buildParityReport({
            errorUsed: 5,
            passiveUsed: 10,
            secondActiveUsed: 0,
            fallbackActiveUsed: 12,
            resetEpoch: WIN_2,
        });

        const legacyStates = new Map();
        const newStates = new Map();

        const steps = [
            {report: step1Report, isInitialHydration: true, nowEpoch: NOW},
            {report: step2Report, isInitialHydration: false, nowEpoch: NOW + 60},
            {report: step3Report, isInitialHydration: false, nowEpoch: WIN_1 + 10},
        ];

        for (const step of steps) {
            const opts = {
                isInitialHydration: step.isInitialHydration,
                nowEpoch: step.nowEpoch,
                hiddenProviderIds: hiddenIds,
                notifyOnWarning: true,
                notifyOnCritical: true,
                notifyOnReset: true,
            };
            const legacyAlerts = legacyEvaluateQuotaNotificationStep(
                legacyStates,
                step.report,
                opts
            );
            const newAlerts = evaluateQuotaNotificationStep(
                newStates,
                step.report,
                opts
            );

            assert.deepEqual(newAlerts, legacyAlerts);
            assert.deepEqual([...newStates.entries()], [...legacyStates.entries()]);
        }
    });
});

// ---------------------------------------------------------------------------
// 7. Shell Command Hardening (`posixShellQuote`, `tokenizeLoginCommand`, `buildTerminalArgv`)
// ---------------------------------------------------------------------------

describe('Shell Command Hardening & Injection Prevention', () => {
    it('quotes arbitrary strings safely and prevents shell command injection in /bin/sh', () => {
        assert.equal(posixShellQuote('claude'), "'claude'");
        assert.equal(posixShellQuote("a'b\0c"), "'a'\\''bc'");
        assert.deepEqual(
            tokenizeLoginCommand('"/opt/My AI Tools/claude" auth login'),
            ['/opt/My AI Tools/claude', 'auth', 'login']
        );

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-shell-sec-'));
        try {
            const markerPath = path.join(tmpDir, 'injected-marker');
            const harmlessBin = path.join(tmpDir, 'mock-login');
            fs.writeFileSync(harmlessBin, '#!/bin/sh\nexit 0\n', {mode: 0o755});

            const payloads = [
                `"${harmlessBin}"; touch "${markerPath}"`,
                `"${harmlessBin}" $(touch "${markerPath}")`,
                `"${harmlessBin}" \`touch "${markerPath}"\``,
                `"${harmlessBin}" | touch "${markerPath}"`,
            ];

            for (const payload of payloads) {
                const argv = buildTerminalArgv('/usr/bin/kitty', payload, {homeDir: tmpDir});
                const nonInteractive = argv[3].replace(/;\s*printf[\s\S]*$/, '');
                try {
                    execFileSync('/bin/sh', ['-c', nonInteractive], {stdio: 'ignore', timeout: 3000});
                } catch (_e) {}
                assert.equal(fs.existsSync(markerPath), false);
            }
        } finally {
            fs.rmSync(tmpDir, {recursive: true, force: true});
        }
    });
});

// ---------------------------------------------------------------------------
// 8. High-Contrast WCAG Verification Across All 24 Themes + GNOME System Light
// ---------------------------------------------------------------------------

describe('High-Contrast WCAG Verification across all 24 themes + system light', () => {
    const cssText = fs.readFileSync(STYLESHEET_PATH, 'utf8');
    const cleanCss = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

    it('enforces St CSS rules: strips host popup background, solidifies system theme, and avoids forbidden CSS', () => {
        assert.equal(/var\s*\(/.test(cleanCss), false, 'CSS must not use var()');
        assert.equal(/calc\s*\(/.test(cleanCss), false, 'CSS must not use calc()');
        assert.equal(/\bgap\s*:/.test(cleanCss), false, 'CSS must not use gap:');
        assert.equal(
            /\b(?:width|min-width|max-width)\s*:\s*\d+(?:\.\d+)?%/.test(cleanCss),
            false,
            'CSS must not use percentage widths'
        );
        assert.equal(/\bscale/.test(cleanCss), false, 'CSS must not use scale transforms');

        const hostBoxMatch = /\.gas-popup-menu-box\s*\{([^}]+)\}/.exec(cleanCss);
        assert.ok(hostBoxMatch, 'Missing .gas-popup-menu-box rule');
        assert.match(hostBoxMatch[1], /background-color:\s*transparent/);

        const sysRoot = extractThemeColorMap(cssText, '.gas-popover.theme-system').get('__root__');
        assert.ok(sysRoot);
        assert.notEqual(sysRoot['background-color'], 'transparent');

        const sysLightRoot = extractThemeColorMap(
            cssText,
            '.gas-popover.theme-system.is-light-surface'
        ).get('__root__');
        assert.ok(sysLightRoot);
        assert.notEqual(sysLightRoot['background-color'], 'transparent');
    });

    const surfaceSpecs = [
        ...THEME_PRESETS.map(p => ({
            id: p.id,
            label: p.label,
            isLight: p.isLight,
            selector: `.gas-popover.theme-${p.id}`,
            hostBg: p.bgHex,
        })),
        {
            id: 'system-light',
            label: 'GNOME System (Light)',
            isLight: true,
            selector: '.gas-popover.theme-system.is-light-surface',
            hostBg: SYSTEM_LIGHT_PALETTE.bgHex,
        },
    ];

    for (const spec of surfaceSpecs) {
        it(`achieves primary >= 10.0:1, secondary >= 5.8:1, and active >= 5.5:1 in ${spec.id}`, () => {
            const map = extractThemeColorMap(cssText, spec.selector);
            const root = map.get('__root__') ?? {};
            assert.ok(root['background-color'], `Missing background-color on ${spec.selector}`);
            assert.notEqual(root['background-color'], 'transparent');

            const hostBackdrop = parseCssColor(spec.hostBg);
            const popBg = compositeOver(parseCssColor(root['background-color']), hostBackdrop);

            const cardBgRaw = map.get('.gas-provider-card')?.['background-color'] ?? 'transparent';
            const cardBg = cardBgRaw === 'transparent'
                ? popBg
                : compositeOver(parseCssColor(cardBgRaw), popBg);

            const heroBgRaw = map.get('.gas-hero-card')?.['background-color'];
            assert.ok(heroBgRaw, `Missing .gas-hero-card background in ${spec.id}`);
            const heroBg = compositeOver(parseCssColor(heroBgRaw), popBg);

            const segBgRaw = map.get('.gas-segmented-track')?.['background-color'];
            const segBg = compositeOver(parseCssColor(segBgRaw), popBg);

            const activeSeg = map.get('.gas-segmented-btn.is-active');
            const activeSegBg = compositeOver(parseCssColor(activeSeg['background-color']), segBg);

            const activeThemeRow = map.get('.gas-theme-row.is-active');
            const activeRowBg = compositeOver(parseCssColor(activeThemeRow['background-color']), popBg);

            const selectedAccount = map.get('.gas-account-row.is-selected');
            const selectedAccountBg = compositeOver(parseCssColor(selectedAccount['background-color']), popBg);

            // 1. Primary text >= 10.0:1 across popover, provider card, and hero card
            assert.ok(
                contrastRatio(root.color, popBg) >= 10.0,
                `${spec.id} primary vs popBg < 10.0:1`
            );
            assert.ok(
                contrastRatio(map.get('.gas-provider-name')?.color, cardBg) >= 10.0,
                `${spec.id} provider-name vs cardBg < 10.0:1`
            );
            assert.ok(
                contrastRatio(map.get('.gas-hero-account-title')?.color, heroBg) >= 10.0,
                `${spec.id} hero-account-title vs heroBg < 10.0:1`
            );

            // 2. Secondary / muted text >= 5.8:1 across all chrome & labels
            const secondaryChecks = [
                ['header-subtitle', map.get('.gas-header-subtitle')?.color, popBg],
                ['plan-badge', map.get('.gas-plan-badge')?.color, cardBg],
                ['reset-label', map.get('.gas-reset-label')?.color, cardBg],
                ['bucket-full-label', map.get('.gas-bucket-full-label')?.color, cardBg],
                ['chevron', map.get('.gas-chevron')?.color, cardBg],
                ['status-note', map.get('.gas-status-note')?.color, cardBg],
                ['signed-out-hint', map.get('.gas-signed-out-hint')?.color, popBg],
                ['section-header', map.get('.gas-section-header')?.color, popBg],
                ['hero-caption-left', map.get('.gas-hero-caption-left')?.color, heroBg],
                ['sparkline-title', map.get('.gas-sparkline-title')?.color, heroBg],
                ['segmented-inactive', map.get('.gas-segmented-btn')?.color, segBg],
            ];
            for (const [label, fg, bg] of secondaryChecks) {
                assert.ok(fg, `Missing ${label} color in ${spec.id}`);
                const ratio = contrastRatio(fg, bg);
                assert.ok(
                    ratio >= 5.8,
                    `${spec.id} -> ${label} (${fg}) contrast ${ratio.toFixed(2)}:1 < 5.8:1`
                );
            }

            // 3. Active pills & selected rows >= 5.5:1
            assert.ok(
                contrastRatio(activeSeg.color, activeSegBg) >= 5.5,
                `${spec.id} active segmented btn contrast < 5.5:1`
            );
            assert.ok(
                contrastRatio(activeThemeRow.color, activeRowBg) >= 5.5,
                `${spec.id} active theme row contrast < 5.5:1`
            );
            assert.ok(
                contrastRatio(selectedAccount.color, selectedAccountBg) >= 5.5,
                `${spec.id} selected account row contrast < 5.5:1`
            );

            // 4. Light-theme avatar medallion contrast >= 10.0:1 for white brand logos
            if (spec.isLight) {
                const avatarBg = map.get('.gas-avatar-ring')?.['background-color'];
                assert.equal(avatarBg, '#222634', `${spec.id} must use #222634 dark slate avatar medallion`);
                assert.ok(
                    contrastRatio('#ffffff', avatarBg) >= 10.0,
                    `${spec.id} white logo vs .gas-avatar-ring < 10.0:1`
                );
            }

            // 5. Semantic warning/critical/error readability >= 4.8:1
            assert.ok(
                contrastRatio(map.get('.gas-bucket-pct.is-warning')?.color, cardBg) >= 4.8,
                `${spec.id} warning pct contrast < 4.8:1`
            );
            assert.ok(
                contrastRatio(map.get('.gas-bucket-pct.is-critical')?.color, cardBg) >= 4.8,
                `${spec.id} critical pct contrast < 4.8:1`
            );
            const errBanner = map.get('.gas-error-banner');
            const errBg = compositeOver(parseCssColor(errBanner['background-color']), popBg);
            assert.ok(
                contrastRatio(errBanner.color, errBg) >= 5.0,
                `${spec.id} error banner contrast < 5.0:1`
            );
        });
    }
});

// ---------------------------------------------------------------------------
// 9. EGO Review Compliance, Import-Scope Purity, Lifecycle & POT Sync
// ---------------------------------------------------------------------------

function extractTopLevelCode(src) {
    let out = '';
    let depth = 0;
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (ch === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n')
                i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/'))
                i++;
            i += 2;
            continue;
        }
        if (ch === '\'' || ch === '"' || ch === '`') {
            const quote = ch;
            if (depth === 0)
                out += quote;
            i++;
            while (i < src.length && src[i] !== quote) {
                if (src[i] === '\\')
                    i += 2;
                else
                    i++;
            }
            if (depth === 0)
                out += quote;
            i++;
            continue;
        }
        if (ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}') {
            depth = Math.max(0, depth - 1);
            i++;
            continue;
        }
        if (depth === 0)
            out += ch;
        i++;
    }
    return out;
}

describe('EGO Review Compliance, Import-Scope Purity, Lifecycle & POT Sync', () => {
    const extDir = path.join(REPO_ROOT, 'extension');
    const popDir = path.join(extDir, 'popover');
    const allExtJsFiles = [
        ...fs.readdirSync(extDir).filter(f => f.endsWith('.js')).map(f => path.join(extDir, f)),
        ...fs.readdirSync(popDir).filter(f => f.endsWith('.js')).map(f => path.join(popDir, f)),
    ].sort();

    it('enforces metadata.json version-name 0.2.0 and clipboard + CLI binary disclosures', () => {
        const meta = JSON.parse(fs.readFileSync(path.join(extDir, 'metadata.json'), 'utf8'));
        assert.equal('version' in meta, false, 'Deprecated integer "version" must be removed');
        assert.equal(meta['version-name'], '0.2.0');
        assert.match(meta.description, /gnome-agent-status/);
        assert.match(meta.description, /Copy Usage Summary/);
        assert.match(meta.description, /clipboard/i);
    });

    it('executes zero GI/GObject/St/Gio/GLib/gettext calls at module import scope or Extension constructors', () => {
        for (const filePath of allExtJsFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            const src = fs.readFileSync(filePath, 'utf8');
            const topLevel = extractTopLevelCode(src)
                .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
                .replace(/\bfunction\s+_\s*\(/g, 'function gettextDecl(');

            assert.equal(
                /\b(?:St|Clutter|Gio|GLib|Gtk|Adw|Gdk|Meta|Shell|Main)\s*\./.test(topLevel),
                false,
                `${rel} must not invoke GI/Shell namespaces at ES module import scope`
            );
            assert.equal(
                /\b_\s*\(/.test(topLevel),
                false,
                `${rel} must not invoke gettext _() at ES module import scope`
            );
        }

        for (const entryFile of ['extension.js', 'prefs.js']) {
            const src = fs.readFileSync(path.join(extDir, entryFile), 'utf8');
            const classIdx = src.indexOf('export default class');
            assert.ok(classIdx >= 0, `Missing default class export in ${entryFile}`);
            assert.equal(
                /\bconstructor\s*\(/.test(src.slice(classIdx)),
                false,
                `${entryFile} must not execute logic inside constructor()`
            );
        }
    });

    it('does not touch Main.extensionManager in indicator.js, reaps login terminal, and tears down pages unconditionally', () => {
        const indicatorSrc = fs.readFileSync(path.join(extDir, 'indicator.js'), 'utf8');
        assert.equal(/extensionManager/.test(indicatorSrc), false);
        assert.equal(/Quit Agent Status/.test(indicatorSrc), false);
        assert.match(indicatorSrc, /Refresh Usage/);
        assert.match(indicatorSrc, /Copy Usage Summary/);
        assert.match(indicatorSrc, /Settings…/);

        const backendSrc = fs.readFileSync(path.join(extDir, 'backend.js'), 'utf8');
        assert.match(
            backendSrc,
            /const\s+proc\s*=\s*Gio\.Subprocess\.new\(argv,\s*Gio\.SubprocessFlags\.NONE\);\s*proc\.wait_async\(null,\s*\(src,\s*res\)\s*=>\s*\{\s*try\s*\{\s*src\.wait_finish\(res\);\s*\}\s*catch\s*\(_e\)\s*\{\}\s*\}\);/
        );
        assert.equal(
            /\bfile_get_contents\b|\bfile_test\b|\bfile_read_link\b/.test(backendSrc),
            false,
            'backend.js must not perform synchronous GLib file I/O on the compositor thread'
        );
        assert.equal(
            /\bquery_exists\b|\bsourceActor\s*=\s*null/.test(indicatorSrc),
            false,
            'indicator.js must not call synchronous query_exists or null out PopupMenu.sourceActor'
        );

        const controllerSrc = fs.readFileSync(path.join(popDir, 'controller.js'), 'utf8');
        const destroyIdx = controllerSrc.lastIndexOf('destroy() {');
        assert.ok(destroyIdx > 0);
        const destroyBody = controllerSrc.slice(destroyIdx);
        const rootGuardMatch = /if\s*\(!this\._rootDisposed\)\s*\{([\s\S]*?)\n\s{8}\}/.exec(destroyBody);
        assert.ok(rootGuardMatch, 'Expected transition guard block in PopoverController.destroy()');
        assert.equal(
            /_mainPage\??\.destroy\s*\(/.test(rootGuardMatch[1]),
            false,
            '_mainPage.destroy() must NOT be gated inside if (!this._rootDisposed)'
        );
        const afterGuard = destroyBody.slice(rootGuardMatch.index + rootGuardMatch[0].length);
        assert.match(afterGuard, /this\._mainPage\?\.destroy\(\)/);
        assert.match(afterGuard, /this\._detailPage\?\.destroy\(\)/);
        assert.match(afterGuard, /this\._themesPage\?\.destroy\(\)/);
    });

    it('keeps po/agent-status.pot strictly valid, duplicate-free, and 100% synced with UI gettext calls', () => {
        const potText = fs.readFileSync(path.join(REPO_ROOT, 'po', 'agent-status.pot'), 'utf8');
        const blocks = potText.trim().split(/\n\n+/);
        assert.ok(blocks.length > 100, 'Expected full POT catalog');

        const seenMsgIds = new Set();
        for (const block of blocks) {
            const lines = block.split('\n');
            let inMsgId = false;
            let inMsgStr = false;
            let msgId = null;
            let msgStr = null;

            for (const line of lines) {
                if (line.startsWith('#'))
                    continue;
                if (line.startsWith('msgid ')) {
                    msgId = JSON.parse(line.slice(6));
                    inMsgId = true;
                    inMsgStr = false;
                } else if (line.startsWith('msgstr ')) {
                    msgStr = JSON.parse(line.slice(7));
                    inMsgId = false;
                    inMsgStr = true;
                } else if (line.startsWith('"')) {
                    const part = JSON.parse(line);
                    if (inMsgId)
                        msgId += part;
                    else if (inMsgStr)
                        msgStr += part;
                } else {
                    assert.fail(`Unexpected POT line syntax: ${line}`);
                }
            }

            assert.notEqual(msgId, null, `Block missing msgid:\n${block}`);
            assert.notEqual(msgStr, null, `Block missing msgstr:\n${block}`);
            assert.equal(seenMsgIds.has(msgId), false, `Duplicate msgid in POT: ${JSON.stringify(msgId)}`);
            seenMsgIds.add(msgId);

            if (msgId === '') {
                assert.match(msgStr, /Content-Type: text\/plain; charset=UTF-8\n/);
                assert.match(msgStr, /MIME-Version: 1\.0\n/);
                assert.match(msgStr, /Plural-Forms: nplurals=2; plural=\(n != 1\);\n/);
            }
        }

        assert.equal(seenMsgIds.has('Quit Agent Status'), false, 'Obsolete Quit Agent Status must be absent');

        for (const item of [...PANEL_MODES, ...PANEL_ACCOUNT_MODES]) {
            assert.equal(
                seenMsgIds.has(item.label),
                true,
                `Constant label missing from po/agent-status.pot: ${JSON.stringify(item.label)}`
            );
            assert.equal(
                seenMsgIds.has(item.shortLabel),
                true,
                `Constant shortLabel missing from po/agent-status.pot: ${JSON.stringify(item.shortLabel)}`
            );
        }

        for (const filePath of allExtJsFiles) {
            const rel = path.relative(REPO_ROOT, filePath);
            const src = fs.readFileSync(filePath, 'utf8');
            const re = /\b(?:_|translate)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)/gs;
            let match;
            while ((match = re.exec(src)) !== null) {
                const raw = match[1] !== undefined ? match[1] : match[2];
                const unescaped = raw.replace(/\\'/g, '\'').replace(/\\"/g, '"').replace(/\\n/g, '\n');
                assert.equal(
                    seenMsgIds.has(unescaped),
                    true,
                    `${rel} string missing from po/agent-status.pot: ${JSON.stringify(unescaped)}`
                );
            }
        }
    });
});
