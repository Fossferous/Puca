import { useEffect, useState } from 'react';
import { EMOJI_CATEGORIES, QUICK_EMOJIS, searchEmojis } from '../api/emojis';
import { Icon } from './Icons';
import './EmojiPicker.css';

interface EmojiPickerProps {
    onSelect: (emoji: string) => void;
    onClose: () => void;
    position?: { x: number; y: number };
    quickMode?: boolean; // Show small quick picker instead of full
}

export function EmojiPicker({ onSelect, onClose, position, quickMode = false }: EmojiPickerProps) {
    const [selectedCategory, setSelectedCategory] = useState(0);
    const [searchQuery, setSearchQuery] = useState('');

    const handleEmojiClick = (emoji: string) => {
        onSelect(emoji);
        onClose();
    };

    // Escape closes, like every other overlay in the app. Clicking the backdrop
    // was the ONLY way out, which on desktop left the picker covering the
    // message list after any keyboard-driven dismissal attempt.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // Quick mode - just show a row of common emojis
    if (quickMode) {
        return (
            <div className="emoji-quick-picker">
                {QUICK_EMOJIS.map((emoji, idx) => (
                    <button
                        key={idx}
                        className="emoji-btn"
                        onClick={() => handleEmojiClick(emoji)}
                    >
                        {emoji}
                    </button>
                ))}
            </div>
        );
    }

    const filteredEmojis = searchQuery
        ? searchEmojis(searchQuery)
        : EMOJI_CATEGORIES[selectedCategory].emojis;

    const style = position ? {
        position: 'fixed' as const,
        left: position.x,
        top: position.y,
    } : {};

    return (
        <div className="emoji-picker-container" style={style}>
            <div className="emoji-picker">
                {/* Search */}
                <div className="emoji-search">
                    <input
                        type="text"
                        placeholder="Search emojis..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoFocus
                    />
                </div>

                {/* Category tabs */}
                {!searchQuery && (
                    <div className="emoji-categories">
                        {EMOJI_CATEGORIES.map((cat, idx) => (
                            <button
                                key={cat.name}
                                className={`emoji-cat-btn ${selectedCategory === idx ? 'active' : ''}`}
                                onClick={() => setSelectedCategory(idx)}
                                title={cat.name}
                            >
                                <Icon name={cat.icon} />
                            </button>
                        ))}
                    </div>
                )}

                {/* Category name */}
                <div className="emoji-category-name">
                    {searchQuery ? 'Search Results' : EMOJI_CATEGORIES[selectedCategory].name}
                </div>

                {/* Emoji grid */}
                <div className="emoji-grid">
                    {filteredEmojis.length > 0 ? (
                        filteredEmojis.map((emoji, idx) => (
                            <button
                                key={idx}
                                className="emoji-btn"
                                onClick={() => handleEmojiClick(emoji)}
                            >
                                {emoji}
                            </button>
                        ))
                    ) : (
                        <div className="emoji-empty">No emojis found</div>
                    )}
                </div>
            </div>

            {/* Backdrop to close */}
            <div className="emoji-backdrop" onClick={onClose} />
        </div>
    );
}
