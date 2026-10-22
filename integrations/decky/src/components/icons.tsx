/**
 * Icons, drawn like Púca's own (frontend/src/components/Icons.tsx): a 24x24
 * outline, currentColor, round caps. Copied rather than imported: the plugin
 * is built on its own, against Steam's React. No emoji (docs/ICON_LANGUAGE.md).
 */
import type { ReactNode } from 'react';

interface IconProps {
    size?: number;
}

function outline(children: ReactNode, size = 18) {
    return (
        <svg
            width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ display: 'block', flex: 'none' }}
        >
            {children}
        </svg>
    );
}

/** Púca's two rings, one colour: the Quick Access menu's plugin icon. */
export function PucaGlyph({ size = 20 }: IconProps) {
    return outline(<>
        <path d="M13.2 18.1A5.6 5.6 0 1 1 9.4 8.6" />
        <path d="M10.8 5.9a5.6 5.6 0 1 1 3.8 9.5" />
        <path d="M9.4 14.6h.01" />
        <path d="M14.6 9.4h.01" />
    </>, size);
}

/** Púca's two rings in their colours: the toast's picture. */
export function PucaIcon({ size = 40 }: IconProps) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
            <path d="M13.2 18.1A5.6 5.6 0 1 1 9.4 8.6" stroke="#26C6DA" />
            <path d="M10.8 5.9a5.6 5.6 0 1 1 3.8 9.5" stroke="#F9B233" />
            <path d="M9.4 14.6h.01" stroke="#26C6DA" strokeWidth={3.2} />
            <path d="M14.6 9.4h.01" stroke="#F9B233" strokeWidth={3.2} />
        </svg>
    );
}

export function MicIcon({ size }: IconProps) {
    return outline(<>
        <rect x="9" y="2.75" width="6" height="11.5" rx="3" />
        <path d="M5.5 11.25v1a6.5 6.5 0 0 0 13 0v-1" />
        <path d="M12 18.75v2.5" />
    </>, size);
}

export function MicOffIcon({ size }: IconProps) {
    return outline(<>
        <path d="M15 4.25a3 3 0 0 0-6-.5v5.5" />
        <path d="M9 12.5a3 3 0 0 0 5.13 1.87" />
        <path d="M5.5 11.25v1a6.5 6.5 0 0 0 10.4 5.2" />
        <path d="M18.5 12.25v-1" />
        <path d="M12 18.75v2.5" />
        <path d="m3.5 3.5 17 17" />
    </>, size);
}

export function NoMicIcon({ size }: IconProps) {
    return outline(<>
        <rect x="9" y="2.75" width="6" height="11.5" rx="3" strokeDasharray="2.25 2.25" />
        <path d="M5.5 11.25v1a6.5 6.5 0 0 0 13 0v-1" />
        <path d="M12 18.75v2.5" />
    </>, size);
}

export function HeadphonesIcon({ size }: IconProps) {
    return outline(<>
        <path d="M3.5 17.5v-5.25a8.5 8.5 0 0 1 17 0v5.25" />
        <path d="M20.5 18.25a2 2 0 0 1-2 2h-.75a1.75 1.75 0 0 1-1.75-1.75v-2.75a1.75 1.75 0 0 1 1.75-1.75h2.75Z" />
        <path d="M3.5 18.25a2 2 0 0 0 2 2h.75a1.75 1.75 0 0 0 1.75-1.75v-2.75a1.75 1.75 0 0 0-1.75-1.75H3.5Z" />
    </>, size);
}

export function HeadphonesOffIcon({ size }: IconProps) {
    return outline(<>
        <path d="M4.25 12.5A8.5 8.5 0 0 1 17.4 5.4" />
        <path d="M20.5 13.75v3.75" />
        <path d="M3.5 14v4.25a2 2 0 0 0 2 2h.75a1.75 1.75 0 0 0 1.75-1.75v-2.75a1.75 1.75 0 0 0-1.75-1.75H4.5" />
        <path d="M20.5 15.25v3a2 2 0 0 1-2 2h-.75a1.75 1.75 0 0 1-1.75-1.75v-2.75a1.75 1.75 0 0 1 1.75-1.75h1.5" />
        <path d="m3.5 3.5 17 17" />
    </>, size);
}

export function LeaveIcon({ size }: IconProps) {
    return outline(<>
        <path d="M10.7 13.3a15.5 15.5 0 0 0 3.4 2.6l1.25-1.25a1.9 1.9 0 0 1 2-.43 12.4 12.4 0 0 0 2.7.68 1.9 1.9 0 0 1 1.65 1.9v2.9a1.9 1.9 0 0 1-2.07 1.9 19.2 19.2 0 0 1-8.35-2.97 18.8 18.8 0 0 1-3.2-2.58" />
        <path d="M5.65 12.9a19.2 19.2 0 0 1-2.9-8.3A1.9 1.9 0 0 1 4.65 2.5h2.9a1.9 1.9 0 0 1 1.9 1.65 12.4 12.4 0 0 0 .68 2.7 1.9 1.9 0 0 1-.43 2L8.4 10.1" />
        <path d="m21.5 2.5-19 19" />
    </>, size);
}

/** Someone talking: a filled dot in the accent colour, an outline when not. */
export function SpeakingDot({ speaking }: { speaking: boolean }) {
    return (
        <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true" style={{ flex: 'none' }}>
            <circle cx="5" cy="5" r="4" fill={speaking ? '#43B581' : 'none'} stroke={speaking ? '#43B581' : 'currentColor'} strokeOpacity={speaking ? 1 : 0.4} strokeWidth={1.5} />
        </svg>
    );
}
