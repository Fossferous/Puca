import { parseMessage, type Node } from './messageParser';

// Extracted from MessageContent so the component file only exports a component
// (keeps React Fast Refresh working).
export function messageMentionsUser(content: string, member: { username: string; display_name?: string | null; server_nickname?: string | null }): boolean {
    const names = [member.username, member.display_name, member.server_nickname]
        .filter(Boolean)
        .map((n) => (n as string).toLowerCase());
    const nodes = parseMessage(content);
    let hit = false;
    const walk = (ns: Node[]) => {
        for (const n of ns) {
            if (n.type === 'mentionEveryone' || n.type === 'mentionHere') hit = true;
            else if (n.type === 'mentionUser' && names.includes(n.name.toLowerCase())) hit = true;
            else if ('children' in n) walk(n.children);
        }
    };
    walk(nodes);
    return hit;
}
