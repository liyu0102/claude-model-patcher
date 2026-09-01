import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import express from 'express';

/**
 * SillyTavern server plugin: claude-model-patcher
 *
 * Problem: SillyTavern decides how a Claude model handles "thinking" (adaptive
 * vs extended/budget vs none) using HARD-CODED regexes on the model name inside
 * src/endpoints/backends/chat-completions.js. When a brand new model such as
 * claude-opus-4-8 is released, ST has not added it to those regexes yet, so it
 * falls into the wrong branch (extended/budget thinking) which the model does
 * not support -> thinking can't be enabled / API errors.
 *
 * This plugin patches the relevant regexes on disk at server startup so that
 * user-defined models (default: claude-opus-4-8) are treated with the correct
 * capabilities (e.g. adaptive thinking, like claude-opus-4-7). It is idempotent
 * and reversible, and is driven by config.json so future models only need a
 * config edit, not a code change.
 *
 * After patching you must RESTART SillyTavern once for the changes to apply,
 * because chat-completions.js is already imported into memory.
 */

const PLUGIN_ID = 'claude-model-patcher';
const LOG = (...args) => console.log(`[${PLUGIN_ID}]`, ...args);
const WARN = (...args) => console.warn(`[${PLUGIN_ID}]`, ...args);
const ERR = (...args) => console.error(`[${PLUGIN_ID}]`, ...args);

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const info = {
    id: PLUGIN_ID,
    name: 'Claude Model Patcher',
    description: 'Adds new/custom Claude models (e.g. claude-opus-4-8) to ST thinking-mode logic so they get the correct thinking behaviour (adaptive / extended / none).',
};

/**
 * Each backend capability maps to a named regex in chat-completions.js.
 * We locate `const <var> = /^claude-(...)/` and inject the model's bare suffix
 * (model id without the leading "claude-") into the alternation group.
 */
const CAP_TO_VAR = {
    useThinking: 'useThinking',
    isAdaptive: 'isAdaptiveModel',
    noSampling: 'noSamplingModel',
    noPrefill: 'noPrefillModel',
    verbosity: 'useVerbosity',
    webSearch: 'useWebSearch',
    limitedSampling: 'isLimitedSampling',
};

function readJsonSafe(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        WARN(`Failed to read/parse ${file}: ${e.message}`);
        return null;
    }
}

function configPath() {
    return path.join(__dirname, 'config.json');
}

function loadConfig() {
    const userCfgPath = configPath();
    const defaultCfgPath = path.join(__dirname, 'config.default.json');

    // Auto-create config.json from the default template on first run.
    if (!fs.existsSync(userCfgPath) && fs.existsSync(defaultCfgPath)) {
        try {
            fs.copyFileSync(defaultCfgPath, userCfgPath);
            LOG('Created config.json from config.default.json. Edit it to add your own models.');
        } catch (e) {
            WARN(`Could not create config.json: ${e.message}`);
        }
    }

    const cfg = readJsonSafe(userCfgPath) || readJsonSafe(defaultCfgPath) || {};
    cfg.enabled = cfg.enabled !== false;
    cfg.patchFrontend = cfg.patchFrontend !== false;
    cfg.openrouterMaxEffort = cfg.openrouterMaxEffort !== false;
    cfg.models = Array.isArray(cfg.models) ? cfg.models : [];
    cfg.caching = normalizeCaching(cfg.caching);
    return cfg;
}

const VALID_THINKING = ['adaptive', 'extended', 'none'];
const BOOL_FLAGS = ['context1m', 'noSampling', 'noPrefill', 'verbosity', 'webSearch', 'limitedSampling'];

/**
 * Prompt-caching settings written into ST's config.yaml (claude: section).
 * manage=false leaves config.yaml completely untouched.
 * cachingAtDepth: -1 disables depth caching; otherwise place it 2 above the
 * boundary where message content stops changing (e.g. summaries beyond
 * layer 10 -> 12).
 */
const CACHING_DEFAULTS = {
    manage: false,
    enableSystemPromptCache: true,
    cachingAtDepth: 12,
    depthMode: 'switches',
    extendedTTL: true,
    patchCustomSource: false,
    debug: false,
};

/**
 * depthMode controls how cachingAtDepth counts its way up from the bottom of
 * the prompt before placing the cache_control breakpoints:
 *  - 'switches': ST stock behaviour, counts user/assistant ROLE SWITCHES.
 *    Breaks down when a long run of same-role messages (e.g. summary-only
 *    assistant messages) gets merged into a single message: the whole run
 *    counts as depth 1 and high depths are never reached.
 *  - 'blocks': counts individual TEXT BLOCKS (one per original chat floor,
 *    even inside merged messages), so the breakpoint can land inside a merged
 *    summary region. Depth N = N-th text block from the bottom.
 */
const VALID_DEPTH_MODES = ['switches', 'blocks'];

function normalizeCaching(input) {
    const c = (input && typeof input === 'object') ? input : {};
    const depth = Number(c.cachingAtDepth);
    return {
        manage: Boolean(c.manage),
        enableSystemPromptCache: c.enableSystemPromptCache !== false,
        cachingAtDepth: Number.isInteger(depth) && depth >= -1 ? depth : CACHING_DEFAULTS.cachingAtDepth,
        depthMode: VALID_DEPTH_MODES.includes(String(c.depthMode)) ? String(c.depthMode) : CACHING_DEFAULTS.depthMode,
        extendedTTL: c.extendedTTL !== false,
        patchCustomSource: Boolean(c.patchCustomSource),
        debug: Boolean(c.debug),
    };
}

/**
 * Validate and normalize a config object coming from the settings panel before
 * writing it to disk. Throws on invalid input.
 */
function sanitizeConfig(input) {
    if (!input || typeof input !== 'object') throw new Error('Config must be an object');
    const out = {
        enabled: input.enabled !== false,
        patchFrontend: input.patchFrontend !== false,
        openrouterMaxEffort: input.openrouterMaxEffort !== false,
        backendFile: typeof input.backendFile === 'string' ? input.backendFile : '',
        frontendFile: typeof input.frontendFile === 'string' ? input.frontendFile : '',
        configYamlFile: typeof input.configYamlFile === 'string' ? input.configYamlFile : '',
        promptConvertersFile: typeof input.promptConvertersFile === 'string' ? input.promptConvertersFile : '',
        caching: normalizeCaching(input.caching),
        models: [],
    };
    const models = Array.isArray(input.models) ? input.models : [];
    const seen = new Set();
    for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        const id = String(m.id || '').trim();
        if (!id) continue;
        if (!/^claude-/.test(id)) throw new Error(`Model id must start with "claude-": ${id}`);
        if (seen.has(id)) continue;
        seen.add(id);
        const thinking = VALID_THINKING.includes(String(m.thinking)) ? String(m.thinking) : 'adaptive';
        const model = { id, thinking };
        for (const flag of BOOL_FLAGS) {
            model[flag] = Boolean(m[flag]);
        }
        out.models.push(model);
    }
    return out;
}

function writeConfig(cfg) {
    const clean = sanitizeConfig(cfg);
    fs.writeFileSync(configPath(), JSON.stringify(clean, null, 4), 'utf8');
    return clean;
}

/**
 * Resolve the path to chat-completions.js.
 * Plugin lives at <ST_ROOT>/plugins/<id>/index.js
 * Target lives at <ST_ROOT>/src/endpoints/backends/chat-completions.js
 */
function resolveBackendFile(cfg) {
    if (cfg.backendFile && fs.existsSync(cfg.backendFile)) return cfg.backendFile;
    const candidates = [
        path.resolve(__dirname, '..', '..', 'src', 'endpoints', 'backends', 'chat-completions.js'),
        path.resolve(__dirname, '..', '..', '..', 'src', 'endpoints', 'backends', 'chat-completions.js'),
        path.resolve(process.cwd(), 'src', 'endpoints', 'backends', 'chat-completions.js'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function resolveFrontendFile(cfg) {
    if (cfg.frontendFile && fs.existsSync(cfg.frontendFile)) return cfg.frontendFile;
    const candidates = [
        path.resolve(__dirname, '..', '..', 'public', 'scripts', 'openai.js'),
        path.resolve(__dirname, '..', '..', '..', 'public', 'scripts', 'openai.js'),
        path.resolve(process.cwd(), 'public', 'scripts', 'openai.js'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function resolveConfigYamlFile(cfg) {
    if (cfg.configYamlFile && fs.existsSync(cfg.configYamlFile)) return cfg.configYamlFile;
    const candidates = [
        path.resolve(__dirname, '..', '..', 'config.yaml'),
        path.resolve(__dirname, '..', '..', '..', 'config.yaml'),
        path.resolve(process.cwd(), 'config.yaml'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

function resolvePromptConvertersFile(cfg) {
    if (cfg.promptConvertersFile && fs.existsSync(cfg.promptConvertersFile)) return cfg.promptConvertersFile;
    const candidates = [
        path.resolve(__dirname, '..', '..', 'src', 'prompt-converters.js'),
        path.resolve(__dirname, '..', '..', '..', 'src', 'prompt-converters.js'),
        path.resolve(process.cwd(), 'src', 'prompt-converters.js'),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

/**
 * Write the prompt-caching keys into the `claude:` section of ST's config.yaml.
 * ST reads these once at startup (module-scoped constants in
 * chat-completions.js), so a restart is required after any change. Keys that
 * are missing from the section (older configs) are appended to it.
 */
function patchConfigYaml(cfg) {
    const c = cfg.caching;
    const file = resolveConfigYamlFile(cfg);
    if (!file) {
        ERR('Could not locate config.yaml. Set "configYamlFile" in config.json to an absolute path.');
        return { ok: false, changed: false };
    }
    LOG(`config.yaml target: ${file}`);

    const content = fs.readFileSync(file, 'utf8');
    const sectionRe = /(^claude:[ \t]*\r?\n)((?:[ \t]+\S.*\r?\n?|[ \t]*\r?\n)*)/m;
    const m = content.match(sectionRe);
    if (!m) {
        ERR('config.yaml: "claude:" section not found (ST version too old?)');
        return { ok: false, changed: false };
    }

    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    let block = m[2];
    const notes = [];
    const sets = [
        ['enableSystemPromptCache', String(c.enableSystemPromptCache)],
        ['cachingAtDepth', String(c.cachingAtDepth)],
        ['extendedTTL', String(c.extendedTTL)],
    ];
    for (const [key, value] of sets) {
        const keyRe = new RegExp(`^([ \\t]+${key}:[ \\t]*)(.*?)([ \\t]*(?:#.*)?)$`, 'm');
        const km = block.match(keyRe);
        if (km) {
            if (km[2] !== value) {
                block = block.replace(keyRe, (s, p1, _old, p3) => `${p1}${value}${p3}`);
                notes.push(`${key}=${value}`);
            }
        } else {
            if (!block.endsWith('\n')) block += eol;
            block += `  ${key}: ${value}${eol}`;
            notes.push(`${key}=${value} (added)`);
        }
    }

    if (notes.length === 0) {
        LOG('config.yaml already up to date, no changes needed.');
        return { ok: true, changed: false };
    }
    backupOnce(file);
    const newContent = content.slice(0, m.index) + m[1] + block + content.slice(m.index + m[0].length);
    fs.writeFileSync(file, newContent, 'utf8');
    LOG('config.yaml patched:', notes.join(', '));
    return { ok: true, changed: true };
}

/**
 * Escape a string for safe use inside a RegExp alternation group `(...)`.
 * Inside such a group a hyphen has no special meaning, so we deliberately keep
 * it un-escaped to match SillyTavern's own style (e.g. "opus-4-8"). We only
 * escape characters that are genuinely meta inside a group.
 */
function escapeForAlternation(s) {
    return s.replace(/[[\]{}()*+?.\\^$|#\s]/g, '\\$&');
}

/**
 * Given a model id like "claude-opus-4-8", return the suffix used inside the
 * `^claude-(...)` alternation, i.e. "opus-4-8".
 */
function bareSuffix(modelId) {
    return String(modelId).replace(/^claude-/, '');
}

/**
 * Inject `suffix` into the alternation group of a `const <varName> = /^claude-(...)/...;`
 * declaration found in `content`. Idempotent: skips if already present.
 * Returns { content, changed, found }.
 */
function injectIntoVarRegex(content, varName, suffix) {
    // Match: const useThinking = /^claude-( ... )/<flags>;
    // Capture the inside of the first (...) group right after ^claude-
    const re = new RegExp(
        `(const\\s+${varName}\\s*=\\s*/\\^claude-\\()([^)]*)(\\)[^;]*;)`,
    );
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const head = m[1];
    const group = m[2];
    const tail = m[3];

    // Build a set of existing alternatives to avoid duplicates.
    const existing = group.split('|').map(s => s.trim());
    const escaped = escapeForAlternation(suffix);
    // Already present (compare against escaped form, since stored escaped)
    if (existing.includes(suffix) || existing.includes(escaped) || group.includes(suffix)) {
        return { content, changed: false, found: true };
    }

    const newGroup = `${group}|${escaped}`;
    const replacement = `${head}${newGroup}${tail}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * Special handling for isAdaptiveModel, whose declaration is:
 *   const isAdaptiveModel = /^claude-(opus-4-7)/.test(request.body.model) || (enableAdaptiveThinking && /^claude-(...)/...);
 * We want to inject into the FIRST (unconditional) regex so adaptive thinking is
 * always on for the model regardless of the enableAdaptiveThinking config flag.
 */
function injectIntoAdaptive(content, suffix) {
    const re = new RegExp(
        `(const\\s+isAdaptiveModel\\s*=\\s*/\\^claude-\\()([^)]*)(\\)/\\.test\\(request\\.body\\.model\\))`,
    );
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const group = m[2];
    const escaped = escapeForAlternation(suffix);
    const existing = group.split('|').map(s => s.trim());
    if (existing.includes(suffix) || existing.includes(escaped) || group.includes(suffix)) {
        return { content, changed: false, found: true };
    }
    const replacement = `${m[1]}${group}|${escaped}${m[3]}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * Frontend 1M context regex in openai.js:
 *   } else if (/^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7)/.test(value)) {
 *       $('#openai_max_context').attr('max', max_1mil);
 */
function injectFrontend1m(content, suffix) {
    const re = /(\/\^claude-\()([^)]*)(\)\/\.test\(value\)\)\s*\{\s*[\r\n]+\s*\$\('#openai_max_context'\)\.attr\('max',\s*max_1mil\);)/;
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const group = m[2];
    const escaped = escapeForAlternation(suffix);
    const existing = group.split('|').map(s => s.trim());
    if (existing.includes(suffix) || existing.includes(escaped) || group.includes(suffix)) {
        return { content, changed: false, found: true };
    }
    const replacement = `${m[1]}${group}|${escaped}${m[3]}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * OpenRouter reasoning effort fix (frontend, public/scripts/openai.js).
 *
 * getReasoningEffort() collapses the "max" (极高) reasoning level down to "high"
 * for every string-effort source, including OpenRouter:
 *   case reasoning_effort_types.max:
 *       return reasoning_effort_types.high;
 * So选择极高时 OpenRouter 实际收到的是 high。For adaptive Claude models routed
 * through OpenRouter we want the real "max" to be preserved. We rewrite that one
 * switch case so that OpenRouter + Claude keeps "max"; every other source keeps
 * the original "high" fallback. Idempotent via a marker comment.
 */
function injectFrontendMaxEffort(content) {
    const marker = 'claude-model-patcher: keep max effort for OpenRouter Claude';
    if (content.includes(marker)) {
        return { content, changed: false, found: true };
    }
    const re = /(case reasoning_effort_types\.max:[\r\n]+\s*)(return reasoning_effort_types\.high;)/;
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const inject =
        `// ${marker}\n` +
        '                if (chat_completion_sources.OPENROUTER === settings.chat_completion_source && /claude/i.test(model)) {\n' +
        '                    return reasoning_effort_types.max;\n' +
        '                }\n' +
        '                ';
    const replacement = `${m[1]}${inject}${m[2]}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * OpenRouter verbosity link (backend, chat-completions.js).
 *
 * For the newest adaptive Claude models (opus 4.8 / fable 5) OpenRouter IGNORES
 * reasoning.effort and instead reads `verbosity` (which it maps to Anthropic's
 * output_config.effort). So sending effort=max alone does not actually raise the
 * thinking budget. When 极高 (reasoning_effort === 'max') is selected on an
 * OpenRouter Claude model, we mirror it into verbosity=max right AFTER the stock
 * verbosity block so it wins. Idempotent via a marker comment.
 */
function injectBackendVerbosityLink(content) {
    const marker = 'claude-model-patcher: link verbosity to max effort';
    if (content.includes(marker)) {
        return { content, changed: false, found: true };
    }
    // Anchor on the OpenRouter-only reasoning line, then extend through its
    // immediately-following verbosity block (the first `request.body.verbosity`
    // block after it), and append the mirror.
    const re = /(bodyParams\['reasoning'\]\['effort'\] = request\.body\.reasoning_effort;[\s\S]*?if \(request\.body\.verbosity\) \{[\s\S]*?bodyParams\['verbosity'\] = request\.body\.verbosity;[\s\S]*?\})/;
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const inject =
        '\n\n' +
        `            // ${marker}\n` +
        "            if (request.body.reasoning_effort === 'max' && /^anthropic\\/claude/.test(request.body.model)) {\n" +
        "                bodyParams['verbosity'] = 'max';\n" +
        '            }';
    const replacement = `${m[1]}${inject}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * Custom (OpenAI-compatible) source cache breakpoints (backend, chat-completions.js).
 *
 * ST only applies Claude cache_control markers on the Claude and OpenRouter
 * branches. Gateways like Vercel AI Gateway are used through the CUSTOM source
 * and pass content-block cache_control straight through to Anthropic, so we
 * inject the same two caching calls into the CUSTOM branch, gated on the model
 * name containing "claude". Idempotent via a marker comment.
 */
function injectCustomSourceCaching(content) {
    const marker = 'claude-model-patcher: cache breakpoints for custom source';
    if (content.includes(marker)) {
        return { content, changed: false, found: true };
    }
    // Anchor on the CUSTOM branch's unique adjacent pair: the custom headers
    // merge immediately followed by the media embed. (The embed call alone also
    // exists in the OPENAI branch, and a bare CUSTOM check exists elsewhere.)
    const re = /(mergeObjectWithYaml\(headers, request\.body\.custom_include_headers\);\r?\n\s*embedOpenRouterMedia\(request\.body\.messages, \{ audio: true, video: false \}\);)/;
    const m = content.match(re);
    if (!m) {
        return { content, changed: false, found: false };
    }
    const inject =
        '\n\n' +
        `            // ${marker}\n` +
        "            if (Array.isArray(request.body.messages) && /(?:^|\\/)claude[-_.]/i.test(String(request.body.model || ''))) {\n" +
        '                if (enableSystemPromptCache) {\n' +
        '                    cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);\n' +
        '                }\n' +
        '                if (cachingAtDepth !== -1) {\n' +
        '                    cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);\n' +
        '                }\n' +
        '            }';
    const replacement = `${m[1]}${inject}`;
    const newContent = content.replace(re, () => replacement);
    return { content: newContent, changed: newContent !== content, found: true };
}

/**
 * Debug logging for cache breakpoints (backend, src/prompt-converters.js).
 *
 * ST's cachingAtDepthForOpenRouterClaude places cache_control markers by walking
 * messages from the newest backwards, counting ROLE SWITCHES (not message
 * indices). Whether a breakpoint lands where you expect is impossible to see
 * from config alone, so this injects a console.log at the exact spot a marker is
 * applied, printing: the depth (role-switch count), the real message index, its
 * distance from the bottom, the role, and the first 40 chars of that message.
 * Also logs the total message count once per call. Idempotent via a marker.
 */
function injectCachingDebug(content) {
    const marker = 'claude-model-patcher: caching debug log';
    if (content.includes(marker)) {
        return { content, changed: false, found: true };
    }

    // 1) Log once at function entry: total messages + the requested depth.
    const entryRe = /(export function cachingAtDepthForOpenRouterClaude\(messages, cachingAtDepth, ttl\) \{\r?\n)/;
    const em = content.match(entryRe);
    if (!em) {
        return { content, changed: false, found: false };
    }
    const entryLog =
        `    // ${marker}\n` +
        "    try { console.log('[claude-model-patcher] cachingAtDepth() called: totalMessages=' + (Array.isArray(messages) ? messages.length : 'N/A') + ', cachingAtDepth=' + cachingAtDepth + ', ttl=' + ttl); } catch (e) {}\n";
    content = content.replace(entryRe, (s, p1) => `${p1}${entryLog}`);

    // 2) Log at each breakpoint hit, inside the `if (depth === cachingAtDepth ...)`
    //    block, right after the opening brace. Anchor on the exact condition line.
    const hitRe = /(if \(depth === cachingAtDepth \|\| depth === cachingAtDepth \+ 2\) \{\r?\n)/;
    const hm = content.match(hitRe);
    if (!hm) {
        // Entry log injected but hit anchor not found; still report what we did.
        return { content, changed: content !== null, found: false };
    }
    const hitLog =
        "                try { const __c = messages[i].content; const __t = typeof __c === 'string' ? __c : (Array.isArray(__c) ? (__c.map(p => p && p.text ? p.text : '').join(' ')) : ''); console.log('[claude-model-patcher] BREAKPOINT set: depth=' + depth + ', messageIndex=' + i + ', fromBottom=' + (messages.length - i) + ', role=' + messages[i].role + ', preview=' + JSON.stringify(String(__t).slice(0, 40))); } catch (e) {}\n";
    content = content.replace(hitRe, (s, p1) => `${p1}${hitLog}`);

    return { content, changed: true, found: true };
}

/**
 * Remove the caching debug log injected by injectCachingDebug (used when the
 * debug flag is turned off again). Idempotent.
 */
function removeCachingDebug(content) {
    const marker = 'claude-model-patcher: caching debug log';
    if (!content.includes(marker)) {
        return { content, changed: false, found: true };
    }
    let out = content;
    // Strip the two injected try/catch console.log lines and the marker comment.
    out = out.replace(/[ \t]*\/\/ claude-model-patcher: caching debug log\r?\n/, '');
    out = out.replace(/[ \t]*try \{ console\.log\('\[claude-model-patcher\] cachingAtDepth\(\) called:.*?\} catch \(e\) \{\}\r?\n/, '');
    out = out.replace(/[ \t]*try \{ const __c = messages\[i\]\.content;.*?\} catch \(e\) \{\}\r?\n/, '');
    return { content: out, changed: out !== content, found: true };
}

/**
 * Block-depth caching mode (backend, src/prompt-converters.js).
 *
 * ST's stock cachingAtDepth counts user/assistant ROLE SWITCHES from the
 * bottom. With summary-style setups the region above the "raw text" boundary
 * is a long run of assistant-only summary messages, which the Claude converter
 * merges into a SINGLE message — the whole region counts as depth 1 and the
 * configured depth is never reached, so no chat breakpoint gets placed at all.
 *
 * Block mode instead counts individual TEXT BLOCKS from the bottom (each
 * original chat floor stays its own block even after merging) and places the
 * two cache_control markers on the N-th and (N+2)-th blocks. This lets the
 * breakpoint land INSIDE the merged summary region, exactly like world-info
 * "@ Depth N" positioning.
 *
 * The generated code is wrapped in BEGIN/END markers and fully regenerated on
 * every patch run (settings like the debug flag are baked in), and the two
 * stock functions get a small marker-tagged delegate at their entry.
 */
const CMP_REGION_BEGIN = '// >>> claude-model-patcher: block-depth caching BEGIN (auto-generated, do not edit)';
const CMP_REGION_END = '// <<< claude-model-patcher: block-depth caching END';
const CMP_DELEGATE_MARKER = 'claude-model-patcher: block-depth delegate';

function buildBlockRegion(cfg) {
    const debug = Boolean(cfg.caching && cfg.caching.debug);
    return [
        CMP_REGION_BEGIN,
        `const CMP_CACHE_DEBUG = ${debug};`,
        'function cmpCacheBlockMode() { return true; }',
        'function cmpCachingAtBlockDepth(messages, blockDepth, ttl) {',
        '    if (!Array.isArray(messages) || !Number.isInteger(blockDepth) || blockDepth < 0) return;',
        "    if (CMP_CACHE_DEBUG) { try { console.log('[claude-model-patcher] block-depth caching: totalMessages=' + messages.length + ', blockDepth=' + blockDepth + ', ttl=' + ttl); } catch (e) {} }",
        '    let passedThePrefill = false;',
        '    let depth = 0;',
        '    let marks = 0;',
        '    const logHit = (i, j, role, text) => {',
        "        if (!CMP_CACHE_DEBUG) return;",
        "        try { console.log('[claude-model-patcher] BLOCK BREAKPOINT set: blockDepth=' + depth + ', messageIndex=' + i + ', partIndex=' + j + ', role=' + role + ', preview=' + JSON.stringify(String(text).slice(0, 40))); } catch (e) {}",
        '    };',
        '    outer:',
        '    for (let i = messages.length - 1; i >= 0; i--) {',
        '        const message = messages[i];',
        '        if (!message) continue;',
        "        if (!passedThePrefill && message.role === 'assistant') continue;",
        '        passedThePrefill = true;',
        "        if (message.role === 'system') continue;",
        "        if (typeof message.content === 'string') {",
        '            if (depth === blockDepth || depth === blockDepth + 2) {',
        "                message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral', ttl: ttl } }];",
        '                marks++;',
        '                logHit(i, 0, message.role, message.content[0].text);',
        '                if (depth === blockDepth + 2) break;',
        '            }',
        '            depth += 1;',
        '        } else if (Array.isArray(message.content)) {',
        '            for (let j = message.content.length - 1; j >= 0; j--) {',
        '                const part = message.content[j];',
        "                if (!part || part.type !== 'text') continue;",
        '                if (depth === blockDepth || depth === blockDepth + 2) {',
        "                    part.cache_control = { type: 'ephemeral', ttl: ttl };",
        '                    marks++;',
        '                    logHit(i, j, message.role, part.text);',
        '                    if (depth === blockDepth + 2) break outer;',
        '                }',
        '                depth += 1;',
        '            }',
        '        }',
        '    }',
        "    if (CMP_CACHE_DEBUG) { try { console.log('[claude-model-patcher] block-depth caching done: breakpointsPlaced=' + marks + ', totalBlocksCounted=' + depth); } catch (e) {} }",
        '}',
        CMP_REGION_END,
    ].join('\n');
}

function removeBlockRegion(content) {
    const re = new RegExp(`\\r?\\n?${CMP_REGION_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${CMP_REGION_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`);
    return content.replace(re, '\n');
}

function appendBlockRegion(content, cfg) {
    if (!content.endsWith('\n')) content += '\n';
    return content + buildBlockRegion(cfg) + '\n';
}

/**
 * Insert the block-mode delegate at the top of both stock depth functions.
 * cachingAtDepthForClaude handles the Claude direct source (merged messages);
 * cachingAtDepthForOpenRouterClaude handles OpenRouter/custom sources.
 */
function injectBlockDelegates(content) {
    let missing = [];
    for (const fnName of ['cachingAtDepthForClaude', 'cachingAtDepthForOpenRouterClaude']) {
        const fnMarker = `${CMP_DELEGATE_MARKER} (${fnName})`;
        if (content.includes(fnMarker)) continue;
        const re = new RegExp(`(export function ${fnName}\\(messages, cachingAtDepth, ttl\\) \\{\\r?\\n)`);
        if (!re.test(content)) {
            missing.push(fnName);
            continue;
        }
        const inject =
            `    // ${fnMarker}\n` +
            '    if (typeof cmpCacheBlockMode === \'function\' && cmpCacheBlockMode()) { return cmpCachingAtBlockDepth(messages, cachingAtDepth, ttl); }\n';
        content = content.replace(re, (s, p1) => `${p1}${inject}`);
    }
    return { content, missing };
}

function removeBlockDelegates(content) {
    const re = new RegExp(`[ \\t]*// ${CMP_DELEGATE_MARKER} \\((\\w+)\\)\\r?\\n[ \\t]*if \\(typeof cmpCacheBlockMode[^\\r\\n]*\\r?\\n`, 'g');
    return content.replace(re, '');
}

function patchPromptConverters(cfg) {
    const file = resolvePromptConvertersFile(cfg);
    if (!file) {
        WARN('Could not locate src/prompt-converters.js; skipping caching debug log.');
        return { ok: false, changed: false };
    }
    LOG(`prompt-converters target: ${file}`);

    let content = fs.readFileSync(file, 'utf8');
    const original = content;
    const wantDebug = Boolean(cfg.caching && cfg.caching.debug);
    const wantBlocks = Boolean(cfg.caching && cfg.caching.depthMode === 'blocks');

    const r = wantDebug ? injectCachingDebug(content) : removeCachingDebug(content);
    if (wantDebug && !r.found) {
        WARN('cachingAtDepthForOpenRouterClaude() not found (ST internals changed?)');
    }
    content = r.content;

    // Block-depth mode: the region is fully regenerated on every run so baked
    // settings (debug flag) stay in sync with the config.
    content = removeBlockRegion(content);
    if (wantBlocks) {
        content = appendBlockRegion(content, cfg);
        const d = injectBlockDelegates(content);
        content = d.content;
        if (d.missing.length) {
            WARN(`Block-depth delegate anchor not found for: ${d.missing.join(', ')} (ST internals changed?)`);
        }
    } else {
        content = removeBlockDelegates(content);
    }

    if (content !== original) {
        backupOnce(file);
        fs.writeFileSync(file, content, 'utf8');
        const notes = [];
        notes.push(wantDebug ? 'debug log ON' : 'debug log off');
        notes.push(wantBlocks ? 'depth mode = blocks (楼层块)' : 'depth mode = switches (ST 原生)');
        LOG(`prompt-converters.js patched: ${notes.join(', ')}`);
        return { ok: true, changed: true };
    }
    LOG('prompt-converters.js already up to date, no changes needed.');
    return { ok: true, changed: false };
}

function backupOnce(file) {
    const bak = `${file}.cmp-bak`;
    if (!fs.existsSync(bak)) {
        try {
            fs.copyFileSync(file, bak);
            LOG(`Backup created: ${path.basename(bak)}`);
        } catch (e) {
            WARN(`Could not create backup for ${file}: ${e.message}`);
        }
    }
}

function patchBackend(cfg) {
    const file = resolveBackendFile(cfg);
    if (!file) {
        ERR('Could not locate chat-completions.js. Set "backendFile" in config.json to an absolute path.');
        return { ok: false, changed: false };
    }
    LOG(`Backend target: ${file}`);

    let content = fs.readFileSync(file, 'utf8');
    const original = content;
    const notes = [];

    for (const model of cfg.models) {
        if (!model || !model.id) continue;
        const suffix = bareSuffix(model.id);

        const thinking = (model.thinking || 'adaptive').toLowerCase();
        // thinking -> useThinking for adaptive & extended
        if (thinking === 'adaptive' || thinking === 'extended') {
            const r = injectIntoVarRegex(content, CAP_TO_VAR.useThinking, suffix);
            if (!r.found) WARN(`var ${CAP_TO_VAR.useThinking} not found (ST internals changed?)`);
            if (r.changed) notes.push(`${model.id} -> useThinking`);
            content = r.content;
        }
        if (thinking === 'adaptive') {
            const r = injectIntoAdaptive(content, suffix);
            if (!r.found) WARN('var isAdaptiveModel not found (ST internals changed?)');
            if (r.changed) notes.push(`${model.id} -> isAdaptiveModel`);
            content = r.content;
        }

        const flagToVar = [
            ['noSampling', CAP_TO_VAR.noSampling],
            ['noPrefill', CAP_TO_VAR.noPrefill],
            ['verbosity', CAP_TO_VAR.verbosity],
            ['webSearch', CAP_TO_VAR.webSearch],
            ['limitedSampling', CAP_TO_VAR.limitedSampling],
        ];
        for (const [flag, varName] of flagToVar) {
            if (model[flag]) {
                const r = injectIntoVarRegex(content, varName, suffix);
                if (!r.found) WARN(`var ${varName} not found (ST internals changed?)`);
                if (r.changed) notes.push(`${model.id} -> ${varName}`);
                content = r.content;
            }
        }
    }

    if (cfg.openrouterMaxEffort) {
        const r = injectBackendVerbosityLink(content);
        if (!r.found) WARN('OpenRouter reasoning/verbosity block not found (ST internals changed?)');
        if (r.changed) notes.push('OpenRouter -> verbosity=max on max effort');
        content = r.content;
    }

    if (cfg.caching && cfg.caching.patchCustomSource) {
        const r = injectCustomSourceCaching(content);
        if (!r.found) WARN('CUSTOM source branch not found (ST internals changed?)');
        if (r.changed) notes.push('CUSTOM source -> claude cache breakpoints');
        content = r.content;
    }

    if (content !== original) {
        backupOnce(file);
        fs.writeFileSync(file, content, 'utf8');
        LOG('Backend patched:', notes.join(', '));
        return { ok: true, changed: true };
    }
    LOG('Backend already up to date, no changes needed.');
    return { ok: true, changed: false };
}

function patchFrontend(cfg) {
    const file = resolveFrontendFile(cfg);
    if (!file) {
        WARN('Could not locate public/scripts/openai.js; skipping frontend 1M-context patch.');
        return { ok: false, changed: false };
    }
    const models1m = cfg.models.filter(m => m && m.id && m.context1m);
    if (models1m.length === 0 && !cfg.openrouterMaxEffort) {
        return { ok: true, changed: false };
    }
    LOG(`Frontend target: ${file}`);

    let content = fs.readFileSync(file, 'utf8');
    const original = content;
    const notes = [];

    for (const model of models1m) {
        const suffix = bareSuffix(model.id);
        const r = injectFrontend1m(content, suffix);
        if (!r.found) {
            WARN('Frontend 1M-context regex not found (ST internals changed?)');
            break;
        }
        if (r.changed) notes.push(`${model.id} -> 1M context`);
        content = r.content;
    }

    if (cfg.openrouterMaxEffort) {
        const r = injectFrontendMaxEffort(content);
        if (!r.found) WARN('Frontend reasoning-effort switch not found (ST internals changed?)');
        if (r.changed) notes.push('OpenRouter -> keep max effort');
        content = r.content;
    }

    if (content !== original) {
        backupOnce(file);
        fs.writeFileSync(file, content, 'utf8');
        LOG('Frontend patched:', notes.join(', '));
        return { ok: true, changed: true };
    }
    LOG('Frontend already up to date, no changes needed.');
    return { ok: true, changed: false };
}

let lastResult = { backend: null, frontend: null, configYaml: null, ranAt: null };

function runPatch() {
    const cfg = loadConfig();
    if (!cfg.enabled) {
        LOG('Disabled via config (enabled: false). Skipping.');
        lastResult = { backend: { ok: true, changed: false, skipped: true }, frontend: null, configYaml: null, ranAt: new Date().toISOString() };
        return lastResult;
    }
    if (cfg.models.length === 0) {
        WARN('No models configured in config.json. Nothing to patch.');
    }

    const backend = patchBackend(cfg);
    const frontend = cfg.patchFrontend ? patchFrontend(cfg) : { ok: true, changed: false, skipped: true };
    const configYaml = cfg.caching.manage ? patchConfigYaml(cfg) : { ok: true, changed: false, skipped: true };
    const promptConverters = patchPromptConverters(cfg);

    lastResult = { backend, frontend, configYaml, promptConverters, ranAt: new Date().toISOString() };

    if (backend.changed || frontend.changed || configYaml.changed || promptConverters.changed) {
        LOG('============================================================');
        LOG('  Patch applied. RESTART SillyTavern once for it to take effect.');
        LOG('============================================================');
    }
    return lastResult;
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    LOG('Initializing...');
    try {
        runPatch();
    } catch (e) {
        ERR('Patch run failed:', e?.stack || e);
    }

    // Status / manual re-run endpoint: GET /api/plugins/claude-model-patcher/
    router.get('/', (req, res) => {
        res.json({
            plugin: info,
            status: 'loaded',
            lastResult,
        });
    });

    // Read current config (for the settings panel).
    router.get('/config', (req, res) => {
        try {
            res.json({ ok: true, config: loadConfig() });
        } catch (e) {
            res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
    });

    // Save config from the settings panel, then immediately re-run the patch.
    router.put('/config', express.json({ limit: '256kb' }), (req, res) => {
        try {
            const saved = writeConfig(req.body);
            const result = runPatch();
            res.json({
                ok: true,
                config: saved,
                result,
                note: 'Saved. Restart SillyTavern for changes to take effect.',
            });
        } catch (e) {
            res.status(400).json({ ok: false, error: String(e?.message || e) });
        }
    });

    // Manually trigger a re-patch (e.g. after editing config.json) without
    // restarting the whole server file-scan. Still requires a restart to apply.
    router.post('/patch', (req, res) => {
        try {
            const result = runPatch();
            res.json({ ok: true, result, note: 'Restart SillyTavern for changes to take effect.' });
        } catch (e) {
            res.status(500).json({ ok: false, error: String(e?.message || e) });
        }
    });

    LOG('Ready. Endpoint: /api/plugins/claude-model-patcher/');
}

export async function exit() {
    LOG('Exiting.');
}

export default { info, init, exit };
