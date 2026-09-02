import { useState } from 'react';
import { ServerAddIcon, LinkIcon, CloseIcon, ChevronRightIcon } from './Icons';
import './WelcomePopup.css';

interface WelcomePopupProps {
    onCreateServer: () => void;
    onJoinServer: () => void;
    onDismiss: () => void;
}

export function WelcomePopup({ onCreateServer, onJoinServer, onDismiss }: WelcomePopupProps) {
    const [hovered, setHovered] = useState<'create' | 'join' | null>(null);

    return (
        <div className="welcome-popup-overlay" onClick={onDismiss}>
            <div className="welcome-popup" onClick={e => e.stopPropagation()}>
                <button className="welcome-popup-close" onClick={onDismiss} aria-label="Close"><CloseIcon size={18} /></button>

                <div className="welcome-popup-header">
                    <h2>Welcome to Púca!</h2>
                    <p>Get started by creating or joining a server</p>
                </div>

                <div className="welcome-popup-options">
                    <button
                        className={`welcome-option ${hovered === 'create' ? 'hovered' : ''}`}
                        onMouseEnter={() => setHovered('create')}
                        onMouseLeave={() => setHovered(null)}
                        onClick={onCreateServer}
                    >
                        <div className="welcome-option-icon"><ServerAddIcon size={32} /></div>
                        <div className="welcome-option-content">
                            <h3>Create a Server</h3>
                            <p>Start your own community with custom channels and roles</p>
                        </div>
                        <div className="welcome-option-arrow"><ChevronRightIcon size={18} /></div>
                    </button>

                    <button
                        className={`welcome-option ${hovered === 'join' ? 'hovered' : ''}`}
                        onMouseEnter={() => setHovered('join')}
                        onMouseLeave={() => setHovered(null)}
                        onClick={onJoinServer}
                    >
                        <div className="welcome-option-icon"><LinkIcon size={32} /></div>
                        <div className="welcome-option-content">
                            <h3>Join a Server</h3>
                            <p>Enter an invite code to join an existing community</p>
                        </div>
                        <div className="welcome-option-arrow"><ChevronRightIcon size={18} /></div>
                    </button>
                </div>

                <div className="welcome-popup-footer">
                    <p>You can also explore the Friends tab to connect with others</p>
                </div>
            </div>
        </div>
    );
}
