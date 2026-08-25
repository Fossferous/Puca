// Link preview utilities for fetching and displaying URL metadata

export interface LinkPreviewData {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    favicon?: string;
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

/** Favicon URL for a domain (Google's favicon service as a reliable fallback). */
function getFaviconUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
    } catch {
        return '';
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
            favicon: getFaviconUrl(url),
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
                image: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
                siteName: 'YouTube',
                favicon: getFaviconUrl(url),
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
                favicon: getFaviconUrl(url),
            };
        }
    }

    // Twitter/X
    if (hostname.includes('twitter.com') || hostname.includes('x.com')) {
        return {
            url,
            title: 'Twitter/X Post',
            siteName: 'Twitter',
            favicon: getFaviconUrl(url),
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
