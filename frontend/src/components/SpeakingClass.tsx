/**
 * Elements that add a `speaking` class while one user is talking — and are
 * the ONLY thing that re-renders when that changes.
 *
 * The sidebar's voice rows used to read speaking state during Chat's render,
 * which is why every speaking flip had to re-render the whole of Chat (message
 * list included). These subscribe to the speaking store for their own user,
 * so a word from somebody repaints one row.
 */
import type { HTMLAttributes, LiHTMLAttributes } from 'react';
import { useUserSpeaking } from './voiceState';

const withSpeaking = (className: string | undefined, speaking: boolean) =>
    speaking ? `${className ?? ''} speaking` : className;

export function SpeakingLi({ userId, className, ...rest }: { userId: number } & LiHTMLAttributes<HTMLLIElement>) {
    const speaking = useUserSpeaking(userId);
    return <li {...rest} className={withSpeaking(className, speaking)} />;
}

export function SpeakingDiv({ userId, className, ...rest }: { userId: number } & HTMLAttributes<HTMLDivElement>) {
    const speaking = useUserSpeaking(userId);
    return <div {...rest} className={withSpeaking(className, speaking)} />;
}
