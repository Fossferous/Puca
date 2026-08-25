import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getChannelFeed, type Channel } from '../api/servers';
import type { FeedMessage } from '../api/servers';
import './ChannelDashboard.css';
import { parseServerTimestamp } from '../utils/serverTime';

interface ChannelDashboardProps {
    channel: Channel;
}

const FeedChild: React.FC<{ name: string; messages: FeedMessage[] }> = ({ name, messages }) => {
    return (
        <div className="feed-child-section">
            <h3 className="feed-child-header"># {name}</h3>
            <div className="feed-messages">
                {messages.length === 0 ? (
                    <div className="feed-empty">No recent messages</div>
                ) : (
                    messages.map((msg) => (
                        <div key={msg.id} className="feed-message">
                            <span className="feed-author">{msg.display_name || msg.username}</span>
                            <span className="feed-time">
                                {new Date(parseServerTimestamp(msg.created_at)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            <p className="feed-content">{msg.content}</p>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export const ChannelDashboard: React.FC<ChannelDashboardProps> = ({ channel }) => {
    const { data: feed, isLoading, error } = useQuery({
        queryKey: ['channelFeed', channel.id],
        queryFn: () => getChannelFeed(channel.id),
        refetchInterval: 5000,
    });

    if (isLoading) return <div className="channel-dashboard loading">Loading feed...</div>;
    if (error) return <div className="channel-dashboard error">Failed to load feed</div>;
    if (!feed) return null;

    return (
        <div className="channel-dashboard">
            <div className="dashboard-content p-4 overflow-y-auto">
                {feed.children.length === 0 ? (
                    <div className="text-center text-[var(--text-muted)] mt-10">
                        This collection is empty.
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {feed.children.map((child) => (
                            <FeedChild key={child.id} name={child.name} messages={child.messages} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
