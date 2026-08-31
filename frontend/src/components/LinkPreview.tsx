import { useState, useEffect } from 'react';
import { extractUrls, fetchLinkPreview, isImageUrl, siteInitial, type LinkPreviewData } from '../api/linkPreview';
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
                    {/*
                      * Deliberately NO <img> anywhere in this card. Both assets it
                      * used to load were third-party (google.com/s2/favicons and
                      * img.youtube.com), so simply rendering a message disclosed
                      * the linked hostname, the reader's IP and the read time to
                      * Google. The card is built entirely from the URL the user
                      * already has. Do not reintroduce a remote src here.
                      */}
                    <div className="link-preview-content">
                        <div className="link-preview-site">
                            <span className="link-preview-mark" aria-hidden="true">
                                {siteInitial(preview.url)}
                            </span>
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
