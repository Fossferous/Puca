// Link preview utilities for fetching and displaying URL metadata

export interface LinkPreviewData {
    url: string;
    title?: string;
    description?: string;
    siteName?: string;
}

// URL detection regex
const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/gi;

/**
 * Extract URLs from message content
 */
export function extractUrls(content: string): string[] {
    const matches = content.match(URL_REGEX);
    // Filter out duplicates and return unique URLs
    return matches ? [...new Set(matches)] : [];
}

/**
 * Check if a URL is an image
 */
export function isImageUrl(url: string): boolean {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
    const lowercaseUrl = url.toLowerCase();
    return imageExtensions.some(ext => lowercaseUrl.includes(ext));
}

/**
 * Site mark for a link — derived LOCALLY, never fetched.
 *
 * This used to return `https://www.google.com/s2/favicons?domain=<hostname>`,
 * which meant that merely RENDERING a message told Google the hostname of the
 * link, the reader's IP and the time they read it — for every link in every
 * channel and DM, with no setting to turn it off. In an app whose whole claim is
 * that nobody can see what you talk about, that was the single widest leak in
 * the product, and it bought only a 16px picture.
 *
 * The card shows the first letter of the registrable name instead. No request,
 * no third party, and it works offline and on a self-hosted LAN deployment.
 */
export function siteInitial(url: string): string {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return (host[0] || '?').toUpperCase();
    } catch {
        return '?';
    }
}

// Cache for link previews to avoid refetching
const previewCache = new Map<string, LinkPreviewData>();

/**
 * Fetch link preview metadata
 * Note: Due to CORS restrictions, this uses a simple approach:
 * - For known services (YouTube, Twitter, etc.), we construct previews directly
 * - For other URLs, we show a basic preview with the domain
 */
export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
    // Check cache first
    if (previewCache.has(url)) {
        return previewCache.get(url)!;
    }

    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace('www.', '');

        // Handle known services with special formatting
        const preview = await getServicePreview(url, hostname);
        if (preview) {
            previewCache.set(url, preview);
            return preview;
        }

        // For other URLs, create a basic preview
        const basicPreview: LinkPreviewData = {
            url,
            title: hostname,
            description: url,
            siteName: hostname,
        };

        previewCache.set(url, basicPreview);
        return basicPreview;
    } catch (error) {
        console.error('Failed to fetch link preview:', error);
        return null;
    }
}

/**
 * Get special previews for known services
 */
async function getServicePreview(url: string, hostname: string): Promise<LinkPreviewData | null> {
    // YouTube
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
        const videoId = extractYouTubeId(url);
        if (videoId) {
            return {
                url,
                title: 'YouTube Video',
                // No thumbnail fetch: img.youtube.com would disclose the video
                // id, the viewer's IP and the read time to Google on render.
                siteName: 'YouTube',
                };
        }
    }

    // GitHub
    if (hostname.includes('github.com')) {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
            return {
                url,
                title: `${parts[0]}/${parts[1]}`,
                description: `GitHub Repository`,
                siteName: 'GitHub',
                };
        }
    }

    // Twitter/X
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        return {
            url,
            title: 'Twitter/X Post',
            siteName: 'Twitter',
        };
    }

    return null;
}

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return null;
}
