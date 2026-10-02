'use strict';
const sharp = require('sharp');
const { createLimiter } = require('./util');
const { tagLabel } = require('./tags');
const { resolveProviderLogoInfo } = require('./providers');

const FONT_STACK = "'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const FALLBACK_LANGS = ['en', 'null', 'ja', 'ko', 'es', 'fr', 'de', 'hi', 'it', 'pt', 'ru', 'zh', 'th', 'tr', 'pl', 'nl', 'sv', 'ar'];
const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/**
 * Everything that differs between posters and backdrops. Sizes are ratios of the source image.
 * (Keeping this as data is what lets one pipeline serve both routes.)
 */
const LAYOUTS = {
    poster: {
        imageList: 'posters',
        size: 'w500',
        preferEnglish: true,
        titleLogo: false,
        placeholder: { width: 500, height: 750, label: 'Poster Unavailable' },
        tag: { heightRatio: 0.08, fontRatio: 0.60 },
        rank(w) {
            const fontSize = Math.round(w * 0.30);
            const padTop = Math.round(w * 0.08);
            const padLeft = Math.round(w * 0.08);
            return { fontSize, x: padLeft, y: padTop + fontSize / 1.3, shimmerW: w * 0.6, shimmerH: fontSize * 2 };
        },
        providerLogo(w) {
            return { width: Math.round(w * 0.15), top: Math.round(w * 0.04), rightPad: Math.round(w * 0.04) };
        },
    },
    backdrop: {
        imageList: 'backdrops',
        size: 'w1280',
        preferEnglish: false,
        titleLogo: true,
        placeholder: { width: 1280, height: 720, label: 'No Background Available' },
        tag: { heightRatio: 0.15, fontRatio: 0.75 },
        rank(w, h) {
            const fontSize = Math.round(h * 0.20);
            const padTop = Math.round(h * 0.05);
            const padLeft = Math.round(w * 0.05);
            return { fontSize, x: padLeft, y: padTop + fontSize / 1.1, shimmerW: w * 0.4, shimmerH: fontSize * 1.5 };
        },
        providerLogo(w, h) {
            return { width: Math.round(w * 0.10), top: Math.round(h * 0.04), rightPad: Math.round(h * 0.04) };
        },
    },
};

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Rough rendered width of `text` at `fontSize` (bold sans-serif). */
function estimateTextWidth(text, fontSize) {
    let w = 0;
    for (const char of text) {
        if ('iIl1., -'.includes(char)) w += fontSize * 0.25;
        else if ('rftj'.includes(char)) w += fontSize * 0.35;
        else if ('WMwm@'.includes(char)) w += fontSize * 0.85;
        else if ('NQDOUCGRHKBAVXY'.includes(char)) w += fontSize * 0.70;
        else if ('PESZT'.includes(char)) w += fontSize * 0.60;
        else w += fontSize * 0.50;
    }
    return w;
}

/** Average colour of the bottom half of the image; decides the tag's text colour and tint. */
async function sampleBottomHalf(imageBuffer, metadata) {
    try {
        const top = Math.floor(metadata.height / 2);
        const height = metadata.height - top;
        const { data, info } = await sharp(imageBuffer)
            .extract({ left: 0, top, width: metadata.width, height })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const { channels } = info;
        const gray = channels < 3; // greyscale (+alpha) sources have no G/B channels
        const pixelCount = info.width * info.height;
        let sumR = 0, sumG = 0, sumB = 0;
        for (let i = 0; i < data.length; i += channels) {
            sumR += data[i];
            sumG += gray ? data[i] : data[i + 1];
            sumB += gray ? data[i] : data[i + 2];
        }
        const meanR = Math.round(sumR / pixelCount);
        const meanG = Math.round(sumG / pixelCount);
        const meanB = Math.round(sumB / pixelCount);
        return { meanR, meanG, meanB, luminance: (0.299 * meanR) + (0.587 * meanG) + (0.114 * meanB) };
    } catch {
        return { meanR: 26, meanG: 26, meanB: 26, luminance: 26 };
    }
}

async function blurRegion(imageBuffer, region) {
    try {
        return await sharp(imageBuffer).extract(region).blur(15).png().toBuffer();
    } catch {
        return null;
    }
}

// ─── Overlays ────────────────────────────────────────────────────────────────

/** Frosted-glass pill along the bottom edge, containing `tagText`. Returns sharp composite operations. */
async function buildTagComposites(imageBuffer, metadata, tagText, heightRatio, fontRatio) {
    const { width, height } = metadata;
    const tagHeight = Math.round(height * heightRatio);
    const fontSize = Math.round(tagHeight * fontRatio);
    const tagWidth = Math.round(estimateTextWidth(tagText, fontSize) + fontSize * 1.8);
    const startX = Math.round((width / 2) - (tagWidth / 2));
    const startY = height - tagHeight;
    const r = Math.round(tagHeight * 0.25);

    const extractLeft = Math.max(0, startX);
    const extractTop = Math.max(0, startY);
    const extractWidth = Math.min(tagWidth, width - extractLeft);
    const extractHeight = Math.min(tagHeight, height - extractTop);

    const [colorInfo, blurBuffer] = await Promise.all([
        sampleBottomHalf(imageBuffer, metadata),
        blurRegion(imageBuffer, { left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight }),
    ]);

    const { meanR, meanG, meanB, luminance } = colorInfo;
    const textColor = luminance > 140 ? '#121212' : '#ffffff';

    // Blend the sampled colour towards white (dark text) or grey (light text)
    const greyMixFactor = 0.25;
    const blendTarget = textColor === '#121212' ? 255 : 128;
    const adjR = Math.round(meanR + (blendTarget - meanR) * greyMixFactor);
    const adjG = Math.round(meanG + (blendTarget - meanG) * greyMixFactor);
    const adjB = Math.round(meanB + (blendTarget - meanB) * greyMixFactor);

    const tagFillColor = `rgb(${adjR}, ${adjG}, ${adjB})`;
    let tagFillOpacity = '0.45';
    const composites = [];

    if (blurBuffer) {
        const localPath = `M 0,${extractHeight} L ${extractWidth},${extractHeight} L ${extractWidth},${r} Q ${extractWidth},0 ${extractWidth - r},0 L ${r},0 Q 0,0 0,${r} Z`;
        const maskSvg = `<svg ${XMLNS} width="${extractWidth}" height="${extractHeight}"><path d="${localPath}" fill="white"/></svg>`;
        const shapedBlur = await sharp(blurBuffer)
            .composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
            .png()
            .toBuffer();
        composites.push({ input: shapedBlur, top: extractTop, left: extractLeft });
    } else {
        tagFillOpacity = '0.85';
    }

    const pillPath = `M ${startX},${height} L ${startX + tagWidth},${height} L ${startX + tagWidth},${startY + r} Q ${startX + tagWidth},${startY} ${startX + tagWidth - r},${startY} L ${startX + r},${startY} Q ${startX},${startY} ${startX},${startY + r} Z`;
    const tagSvg = `<svg ${XMLNS} width="${width}" height="${height}">
        <path d="${pillPath}" fill="${tagFillColor}" fill-opacity="${tagFillOpacity}"/>
        <text x="${width / 2}" y="${startY + (tagHeight / 2) + (fontSize * 0.35)}" text-anchor="middle"
              font-family="${FONT_STACK}" font-size="${fontSize}" fill="${textColor}" font-weight="bold">${escapeXml(tagText)}</text>
    </svg>`;
    composites.push({ input: Buffer.from(tagSvg), top: 0, left: 0 });
    return composites;
}

/** Big silver rank number with a soft shadow, top-left. */
function buildRankComposite(layout, rankText, width, height) {
    const g = layout.rank(width, height);
    const svg = `<svg ${XMLNS} width="${width}" height="${height}">
        <defs>
            <linearGradient id="rankGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%"   style="stop-color:#ffffff;stop-opacity:1"/>
                <stop offset="60%"  style="stop-color:#c0c0c0;stop-opacity:1"/>
                <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
            </linearGradient>
            <filter id="rankShadow" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
                <feOffset dx="3" dy="3" result="offsetblur"/>
                <feFlood flood-color="black" flood-opacity="0.9"/>
                <feComposite in2="offsetblur" operator="in"/>
                <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <radialGradient id="shimmerGradient" cx="0%" cy="0%" r="100%" fx="0%" fy="0%">
                <stop offset="0%"   style="stop-color:black;stop-opacity:0.6"/>
                <stop offset="40%"  style="stop-color:black;stop-opacity:0.3"/>
                <stop offset="100%" style="stop-color:black;stop-opacity:0"/>
            </radialGradient>
        </defs>
        <rect x="0" y="0" width="${g.shimmerW}" height="${g.shimmerH}" fill="url(#shimmerGradient)"/>
        <text x="${g.x}" y="${g.y}" text-anchor="start"
              font-family="${FONT_STACK}" font-size="${g.fontSize}"
              fill="url(#rankGradient)" fill-opacity="0.80" font-weight="bold"
              filter="url(#rankShadow)">${escapeXml(rankText)}</text>
    </svg>`;
    return { input: Buffer.from(svg), top: 0, left: 0 };
}

/** Streaming-service / network logo, top-right. Returns null (and the image is still served) if anything goes wrong. */
async function buildProviderLogo(tmdb, info, layout, width, height, logger) {
    if (!info?.path) return null;
    try {
        const { width: logoWidth, top, rightPad } = layout.providerLogo(width, height);
        const buf = await tmdb.image('w154', info.path);
        let resized = await sharp(buf).resize({ width: logoWidth, withoutEnlargement: true }).png().toBuffer();
        const meta = await sharp(resized).metadata();

        if (!info.isNetwork) {
            const radius = Math.round(logoWidth * 0.2);
            const mask = Buffer.from(`<svg ${XMLNS} width="${meta.width}" height="${meta.height}">
                <rect x="0" y="0" width="${meta.width}" height="${meta.height}" rx="${radius}" ry="${radius}" fill="white"/>
            </svg>`);
            resized = await sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        }
        return { input: resized, top, left: Math.round(width - meta.width - rightPad) };
    } catch (err) {
        logger.error('Provider logo error:', err.message);
        return null;
    }
}

/** Title logo, bottom-left (backdrops with a textless background only). */
async function buildTitleLogo(tmdb, logo, width, height, logger) {
    try {
        const buf = await tmdb.image('original', logo.file_path);
        let resized = await sharp(buf)
            .resize({ width: Math.round(width * 0.50), height: Math.round(height * 0.50), fit: 'inside' })
            .png()
            .toBuffer();
        const meta = await sharp(resized).metadata();

        const targetLeft = Math.round(width * 0.05);
        const targetTop = height - meta.height - Math.round(height * 0.20);

        // sharp refuses overlays that extend past the base image, so crop whatever would overhang
        const cropLeft = Math.max(0, -targetLeft);
        const cropTop = Math.max(0, -targetTop);
        const cropWidth = Math.min(meta.width, width - targetLeft) - cropLeft;
        const cropHeight = Math.min(meta.height, height - targetTop) - cropTop;
        if (cropWidth <= 0 || cropHeight <= 0) return null;
        if (cropWidth < meta.width || cropHeight < meta.height) {
            resized = await sharp(resized)
                .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
                .toBuffer();
        }
        return { input: resized, left: targetLeft + cropLeft, top: targetTop + cropTop };
    } catch (err) {
        logger.error('Title logo error:', err.message);
        return null;
    }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/** First image whose language matches the earliest entry of `preferences` that has any. */
function pickByLanguage(images, preferences) {
    for (const lang of preferences) {
        const hit = images.find((im) => im.iso_639_1 === lang);
        if (hit) return hit;
    }
    return null;
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./tmdb').createTmdbClient>} deps.tmdb
 * @param {number} [deps.concurrency] how many images may be composited at once (CPU/memory bound)
 */
function createArtwork({ tmdb, concurrency = 4, logger = console }) {
    const limit = createLimiter(concurrency);
    const placeholders = new Map();

    /** Locally generated stand-in for titles with no image (no dependency on an external placeholder service). */
    function placeholder(kind) {
        if (!placeholders.has(kind)) {
            const { width, height, label } = LAYOUTS[kind].placeholder;
            const svg = `<svg ${XMLNS} width="${width}" height="${height}">
                <rect width="100%" height="100%" fill="#1e1e1e"/>
                <text x="50%" y="50%" text-anchor="middle" fill="#8a8a8a" font-family="${FONT_STACK}" font-size="${Math.round(height * 0.04)}">${escapeXml(label)}</text>
            </svg>`;
            placeholders.set(kind, sharp(Buffer.from(svg)).png().toBuffer());
        }
        return placeholders.get(kind);
    }

    /**
     * @param {{kind:'poster'|'backdrop', id:string, type:'movie'|'series', tag:string, rank:string, lang:string, logos:boolean}} params
     *        (already validated by the caller)
     * @returns {Promise<{kind:'image', buffer:Buffer} | {kind:'redirect', url:string} | {kind:'placeholder', buffer:Buffer}>}
     */
    async function render(params) {
        const layout = LAYOUTS[params.kind];
        const tmdbType = params.type === 'series' ? 'tv' : 'movie';
        const tagText = tagLabel(params.tag);
        const rankText = params.rank !== 'none' ? params.rank : null;

        const details = await tmdb.json(`/${tmdbType}/${params.id}`);
        const originalLang = details.original_language;

        const langs = [...new Set([params.lang, originalLang, ...FALLBACK_LANGS])].filter(Boolean);
        const allowed = new Set(langs.map((l) => (l === 'null' ? null : l)));

        const [images, providers] = await Promise.all([
            tmdb.json(`/${tmdbType}/${params.id}/images`, { include_image_language: langs.join(',') }),
            // The corner logo is decoration: if this lookup fails, still serve the artwork without it
            params.logos ? tmdb.json(`/${tmdbType}/${params.id}/watch/providers`).catch(() => null) : null,
        ]);

        const candidates = (images[layout.imageList] || []).filter((im) => allowed.has(im.iso_639_1));
        const wanted = params.lang === 'null' ? null : params.lang;
        const image = pickByLanguage(candidates, [wanted, originalLang, null, ...(layout.preferEnglish ? ['en'] : [])])
            || candidates[0];
        if (!image?.file_path) return { kind: 'placeholder', buffer: await placeholder(params.kind) };

        // A title logo goes on textless backdrops only
        let titleLogo = null;
        if (layout.titleLogo && params.lang !== 'null' && image.iso_639_1 === null && images.logos?.length) {
            titleLogo = pickByLanguage(images.logos, [params.lang, originalLang, 'en']) || images.logos[0];
        }
        const providerInfo = params.logos
            ? resolveProviderLogoInfo(tmdbType, { ...details, 'watch/providers': providers })
            : null;

        const passthrough = { kind: 'redirect', url: tmdb.imageUrl(layout.size, image.file_path) };
        if (!tagText && !rankText && !providerInfo && !titleLogo) return passthrough; // nothing to draw

        const base = await tmdb.image(layout.size, image.file_path);

        const buffer = await limit(async () => {
            const { width, height } = await sharp(base).metadata();
            const meta = { width, height };
            const [tagOps, providerOp, titleOp] = await Promise.all([
                tagText ? buildTagComposites(base, meta, tagText, layout.tag.heightRatio, layout.tag.fontRatio) : [],
                providerInfo ? buildProviderLogo(tmdb, providerInfo, layout, width, height, logger) : null,
                titleLogo ? buildTitleLogo(tmdb, titleLogo, width, height, logger) : null,
            ]);
            const ops = [
                rankText ? buildRankComposite(layout, rankText, width, height) : null,
                ...tagOps,
                titleOp,
                providerOp,
            ].filter(Boolean);
            if (ops.length === 0) return null; // e.g. only a logo was requested and it failed to load
            return sharp(base).composite(ops).png().toBuffer();
        });

        return buffer ? { kind: 'image', buffer } : passthrough;
    }

    return { render };
}

module.exports = { createArtwork, LAYOUTS, escapeXml, estimateTextWidth, sampleBottomHalf, buildTagComposites, buildRankComposite };
