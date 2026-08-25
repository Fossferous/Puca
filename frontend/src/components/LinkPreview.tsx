import { useState, useEffect } from 'react';
import { extractUrls, fetchLinkPreview, isImageUrl, type LinkPreviewData } from '../api/linkPreview';
import './LinkPreview.css';

interface LinkPreviewProps {
    content: string;
}

export function LinkPreview({ content }: LinkPreviewProps) {
    const [previews, setPreviews] = useState<LinkPreviewData[]>([]);

    useEffect(() => {
        const urls = extractUrls(content);
        // Filter out image URLs (they're already rendered inline) and localhost URLs (internal files)
        const nonImageUrls = urls.filter(url => {
            if (isImageUrl(url)) return false;
            try {
                const urlObj = new URL(url);
                if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') return false;
            } catch { /* invalid URL */ }
            return true;
        });

        if (nonImageUrls.length === 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale previews when no URLs remain
            setPreviews([]);
            return;
        }

        // Fetch previews for up to 3 URLs
        const fetchPreviews = async () => {
            const results = await Promise.all(
                nonImageUrls.slice(0, 3).map(url => fetchLinkPreview(url))
            );
            setPreviews(results.filter((p): p is LinkPreviewData => p !== null));
        };

        fetchPreviews();
    }, [content]);

    if (previews.length === 0) {
        return null;
    }

    return (
        <div className="link-previews">
            {previews.map((preview) => (
                <a
                    key={preview.url}
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-preview-card"
                >
                    {preview.image && (
                        <div className="link-preview-image">
                            <img
                                src={preview.image}
                                alt=""
                                onError={(e) => {
                                    // Hide broken images
                                    (e.target as HTMLImageElement).style.display = 'none';
                                }}
                            />
                        </div>
                    )}
                    <div className="link-preview-content">
                        <div className="link-preview-site">
                            {preview.favicon && (
                                <img src={preview.favicon} alt="" className="link-preview-favicon" />
                            )}
                            <span>{preview.siteName || new URL(preview.url).hostname}</span>
                        </div>
                        {preview.title && (
                            <div className="link-preview-title">{preview.title}</div>
                        )}
                        {preview.description && (
                            <div className="link-preview-description">{preview.description}</div>
                        )}
                    </div>
                </a>
            ))}
        </div>
    );
}
