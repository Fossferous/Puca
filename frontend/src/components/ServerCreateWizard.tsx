import { useState } from 'react';
import { Icon, type IconName, ArrowLeftIcon, ChevronRightIcon, CloseIcon, GlobeIcon, ImageIcon, MembersIcon } from './Icons';
import './ServerCreateWizard.css';

/** Everything the wizard collected. Every field is acted on (api/serverTemplates.ts). */
export interface WizardResult {
    name: string;
    /** A key of SERVER_TEMPLATES; 'custom' keeps the stock channels. */
    template: string;
    /** List in the public directory — explicit, default off. */
    isPublic: boolean;
    iconFile: File | null;
}

interface ServerCreateWizardProps {
    isOpen: boolean;
    onClose: () => void;
    onComplete: (result: WizardResult) => void;
    /** "Have an invite already?" — close this wizard and open the join modal. */
    onJoinInstead: () => void;
}

type WizardStep = 'template' | 'audience' | 'customize';

interface Template {
    id: string;
    name: string;
    icon: IconName;
    description: string;
}

const templates: Template[] = [
    { id: 'custom', name: 'Create My Own', icon: 'wrench', description: 'Start from scratch with a blank server' },
    { id: 'gaming', name: 'Gaming', icon: 'gamepad', description: 'For gaming communities and friends' },
    { id: 'school', name: 'School Club', icon: 'book', description: 'For study groups and school organizations' },
    { id: 'creative', name: 'Creative', icon: 'palette', description: 'For artists, musicians, and creators' },
    { id: 'community', name: 'Community', icon: 'globe', description: 'For local communities and interest groups' },
];

export function ServerCreateWizard({ isOpen, onClose, onComplete, onJoinInstead }: ServerCreateWizardProps) {
    const [step, setStep] = useState<WizardStep>('template');
    const [selectedTemplate, setSelectedTemplate] = useState<string>('custom');
    const [audience, setAudience] = useState<'community' | 'friends'>('friends');
    const [serverName, setServerName] = useState('');
    const [serverIcon, setServerIcon] = useState<string | null>(null);
    const [iconFile, setIconFile] = useState<File | null>(null);
    // "For a club or community" does not publish anything by itself: listing
    // a server in the public directory is a separate, explicit tick.
    const [listPublicly, setListPublicly] = useState(false);

    const resetWizard = () => {
        setStep('template');
        setSelectedTemplate('custom');
        setAudience('friends');
        setServerName('');
        setServerIcon(null);
        setIconFile(null);
        setListPublicly(false);
    };

    const handleClose = () => {
        resetWizard();
        onClose();
    };

    const handleTemplateSelect = (templateId: string) => {
        setSelectedTemplate(templateId);
        // Set a default name based on template
        const template = templates.find(t => t.id === templateId);
        if (template && templateId !== 'custom') {
            setServerName(`My ${template.name} Server`);
        }
        setStep('audience');
    };

    const handleAudienceSelect = (selected: 'community' | 'friends') => {
        setAudience(selected);
        setStep('customize');
    };

    const handleBack = () => {
        if (step === 'audience') setStep('template');
        else if (step === 'customize') setStep('audience');
    };

    const handleCreate = () => {
        if (serverName.trim()) {
            onComplete({
                name: serverName.trim(),
                template: selectedTemplate,
                isPublic: audience === 'community' && listPublicly,
                iconFile,
            });
            handleClose();
        }
    };

    const handleIconUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.type.startsWith('image/')) {
            setIconFile(file);
            const reader = new FileReader();
            reader.onload = (event) => {
                setServerIcon(event.target?.result as string);
            };
            reader.readAsDataURL(file);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="wizard-overlay" onClick={handleClose}>
            <div className="wizard-modal" onClick={e => e.stopPropagation()}>
                {/* Close button */}
                <button className="wizard-close" aria-label="Close" onClick={handleClose}><CloseIcon size={18} /></button>

                {/* Step: Template Selection */}
                {step === 'template' && (
                    <div className="wizard-step template-step">
                        <h2>Create a server</h2>
                        <p className="wizard-subtitle">
                            Your server is where you and your friends hang out. Make yours and start talking.
                        </p>

                        <div className="template-list">
                            {templates.map(template => (
                                <button
                                    key={template.id}
                                    className="template-card"
                                    onClick={() => handleTemplateSelect(template.id)}
                                >
                                    <span className="template-icon"><Icon name={template.icon} /></span>
                                    <div className="template-info">
                                        <span className="template-name">{template.name}</span>
                                        <span className="template-desc">{template.description}</span>
                                    </div>
                                    <span className="template-arrow"><ChevronRightIcon size={16} /></span>
                                </button>
                            ))}
                        </div>

                        <div className="wizard-footer">
                            <p className="join-prompt">Have an invite already?</p>
                            <button
                                className="join-link"
                                onClick={() => { resetWizard(); onJoinInstead(); }}
                            >
                                Join a Server
                            </button>
                        </div>
                    </div>
                )}

                {/* Step: Audience Selection */}
                {step === 'audience' && (
                    <div className="wizard-step audience-step">
                        <button className="wizard-back" onClick={handleBack}><ArrowLeftIcon /> Back</button>
                        <h2>Tell us more about your server</h2>
                        <p className="wizard-subtitle">
                            This helps us customize your experience. You can always change this later.
                        </p>

                        <div className="audience-options">
                            <button
                                className={`audience-card ${audience === 'community' ? 'selected' : ''}`}
                                onClick={() => handleAudienceSelect('community')}
                            >
                                <span className="audience-icon"><GlobeIcon /></span>
                                <span className="audience-label">For a club or community</span>
                                <span className="audience-desc">Perfect for public-facing groups</span>
                            </button>

                            <button
                                className={`audience-card ${audience === 'friends' ? 'selected' : ''}`}
                                onClick={() => handleAudienceSelect('friends')}
                            >
                                <span className="audience-icon"><MembersIcon /></span>
                                <span className="audience-label">For me and my friends</span>
                                <span className="audience-desc">A private space for your inner circle</span>
                            </button>
                        </div>

                        <p className="skip-note">Not sure? You can skip this question</p>
                        <button className="skip-btn" onClick={() => setStep('customize')}>
                            Skip this question
                        </button>
                    </div>
                )}

                {/* Step: Customization */}
                {step === 'customize' && (
                    <div className="wizard-step customize-step">
                        <button className="wizard-back" onClick={handleBack}><ArrowLeftIcon /> Back</button>
                        <h2>Customize your server</h2>
                        <p className="wizard-subtitle">
                            Give your new server a personality with a name and an icon. You can always change it later.
                        </p>

                        <div className="server-icon-upload">
                            <label className="icon-upload-label">
                                {serverIcon ? (
                                    <img src={serverIcon} alt="Server icon" className="uploaded-icon" />
                                ) : (
                                    <div className="icon-placeholder">
                                        <span className="camera-icon"><ImageIcon /></span>
                                        <span>UPLOAD</span>
                                    </div>
                                )}
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={handleIconUpload}
                                    hidden
                                />
                            </label>
                        </div>

                        <div className="server-name-input">
                            <label>SERVER NAME</label>
                            <input
                                type="text"
                                value={serverName}
                                onChange={e => setServerName(e.target.value)}
                                placeholder="Enter server name"
                                autoFocus
                            />
                        </div>

                        {audience === 'community' && (
                            <label className="wizard-public-toggle">
                                <input
                                    type="checkbox"
                                    checked={listPublicly}
                                    onChange={e => setListPublicly(e.target.checked)}
                                />
                                <span>
                                    <strong>List in the public directory</strong>
                                    <small>Anyone on this server's instance can find and join it. Off, it stays invite-only. You can change this in Server Settings.</small>
                                </span>
                            </label>
                        )}

                        <div className="wizard-actions">
                            <button className="back-btn" onClick={handleBack}>Back</button>
                            <button
                                className="create-btn"
                                onClick={handleCreate}
                                disabled={!serverName.trim()}
                            >
                                Create
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
