import { useState, useEffect, useRef } from 'react';
import { Banner, Text, InlineStack, BlockStack, Button, Box, ProgressBar, Bleed, Icon, Popover, ActionList } from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';
import { useSubmit, useNavigation } from '@remix-run/react';
import './SyncManager.css';

const ErrorBoundary = ({ children }) => {
    const [error, setError] = useState(null);

    if (error) {
        return (
            <Banner status="critical" title="An error occurred">
                <BlockStack gap="200">
                    <Text variant="bodyMd">{error.message}</Text>
                    <Button onClick={() => setError(null)} plain>
                        Try Again
                    </Button>
                </BlockStack>
            </Banner>
        );
    }

    return children;
};


export function SyncManager({ logos, actionData, autoDismissDelay = 15000 }) {
    const submit = useSubmit();
    const navigation = useNavigation();
    const [syncStates, setSyncStates] = useState({
        tourismNZ: { isPolling: false, progress: 0, phase: 'Initialising', error: null },
        eventfinda: { isPolling: false, progress: 0, phase: 'Initialising', error: null }
    });
    const [notifications, setNotifications] = useState([]);
    const lastBatchKey = useRef(null);
    const [popoverActive, setPopoverActive] = useState({
        tourismNZ: false,
        eventfinda: false
    });

    const submittingType = navigation.state !== 'idle' ? navigation.formData?.get('listingType') : null;
    const isSyncing = Boolean(submittingType) || Object.values(syncStates).some(state => state.isPolling);

    useEffect(() => {
        if (actionData?.success && actionData?.status === 'batching' && actionData?.jobId) {
            const type = actionData.listingType;
            setSyncStates(prev => ({
                ...prev,
                [type]: {
                    ...prev[type],
                    isPolling: true,
                    progress: actionData.progress ?? 0,
                    phase: `Syncing ${actionData.processed ?? 0}/${actionData.total ?? 0}`,
                    error: null
                }
            }));

            // Submit exactly one follow-up request for each returned cursor/progress
            // state. Each request gets a fresh Cloudflare subrequest allowance.
            const batchKey = `${actionData.jobId}:${actionData.batchToken ?? `${actionData.progress}:${actionData.processed}`}`;
            if (lastBatchKey.current !== batchKey) {
                lastBatchKey.current = batchKey;
                const formData = new FormData();
                formData.append('action', 'process-batch');
                formData.append('listingType', type);
                formData.append('jobId', actionData.jobId);
                submit(formData, { method: 'post' });
            }
        } else if (actionData?.success && actionData?.status === 'complete') {
            const type = actionData.listingType || (actionData.message?.includes('tourismNZ') ? 'tourismNZ' : 'eventfinda');
            lastBatchKey.current = null;
            setSyncStates(prev => ({
                ...prev,
                [type]: { ...prev[type], progress: 100, phase: 'Complete', error: null, isPolling: false }
            }));
            addNotification(`${type === 'tourismNZ' ? 'Tourism NZ' : 'Eventfinda'} sync completed successfully!`, 'success');
        } else if (actionData?.success === false) {
            lastBatchKey.current = null;
            const type = actionData.listingType;
            if (type) {
                setSyncStates(prev => ({
                    ...prev,
                    [type]: { ...prev[type], isPolling: false, error: actionData.error || actionData.message }
                }));
            }
            addNotification(actionData.error || actionData.message || 'Sync failed', 'critical');
        }
    }, [actionData, submit]);

    const addNotification = (message, status = 'success') => {
        const id = Date.now();
        setNotifications(prev => [...prev, { id, message, status }]);
        setTimeout(() => {
            setNotifications(prev => prev.filter(n => n.id !== id));
        }, autoDismissDelay);
    };

    const handleSync = (type, isInitialSync = false) => {
        lastBatchKey.current = null;
        setSyncStates(prev => ({
            ...prev,
            [type]: { ...prev[type], isPolling: true, progress: 0, phase: 'Preparing sync', error: null }
        }));
        const formData = new FormData();
        formData.append('listingType', type);
        if (isInitialSync) {
            formData.append('isInitialSync', 'true');
        }
        submit(formData, { method: 'post' });
        
        // Close the popover after submitting
        setPopoverActive(prev => ({
            ...prev,
            [type]: false
        }));
    };

    const togglePopover = (type) => {
        setPopoverActive(prev => ({
            ...prev,
            [type]: !prev[type]
        }));
    };

    return (
        <ErrorBoundary>
            <BlockStack gap="500">
                {notifications.map(({ id, message, status }) => (
                    <Banner
                        key={id}
                        title={status === 'success' ? 'Success' : 'Error'}
                        status={status}
                        onDismiss={() => setNotifications(prev => prev.filter(n => n.id !== id))}
                    >
                        <Text variant="bodyMd">{message}</Text>
                    </Banner>
                ))}

                <BlockStack gap="500">
                    {Object.entries(syncStates).map(([type, state]) => (
                        <Box
                            key={type}
                            background="bg-surface"
                            paddingBlock="600"
                            paddingInline="800"
                            shadow={state.isPolling ? "400" : "200"}                            
                        >
                            <ErrorBoundary>
                                <BlockStack gap="300">
                                    <InlineStack align="space-between" blockAlign="center">
                                        <img src={logos[type]} alt={type} style={{ maxHeight: '45px', height: '45px' }} />
                                        
                                        <Popover
                                            active={popoverActive[type]}
                                            activator={
                                                <Button 
                                                    onClick={() => togglePopover(type)}

                                                    disclosure
                                                    disabled={isSyncing}
                                                >
                                                    {submittingType === type ? 'Syncing...' : 'Sync Options'}
                                                </Button>
                                            }
                                            onClose={() => togglePopover(type)}
                                        >
                                            <ActionList
                                                items={[
                                                    {
                                                        content: '24-Hour Sync',
                                                        helpText: 'Daily maintenance - only fetch recent updates',
                                                        onAction: () => handleSync(type, false)
                                                    },
                                                    {
                                                        content: 'Historical Sync',
                                                        helpText: 'Complete system refresh (may take longer)',
                                                        onAction: () => handleSync(type, true)
                                                    }
                                                ]}
                                            />
                                        </Popover>
                                    </InlineStack>

                                    
                                    <div className={`progress-container ${submittingType === type ? 'active' : ''}`}>    
                                    {submittingType === type && (                                    
                                            <Box>
                                                <BlockStack gap="200">
                                                    <>
                                                        <InlineStack align="space-between">
                                                            <Text 
                                                                variant="bodySm" 
                                                                as="span" 
                                                                tone="subdued"                                                                
                                                            >
                                                                Syncing products…
                                                            </Text>
                                                            <Text 
                                                                variant="bodySm" 
                                                                as="span" 
                                                                tone="subdued"
                                                            >
                                                                Working
                                                            </Text>
                                                        </InlineStack>
                                                        <div className="progress-bar-wrapper">
                                                            <ProgressBar
                                                                progress={actionData?.listingType === type ? (actionData?.progress ?? state.progress ?? 0) : (state.progress ?? 0)}
                                                                size="small"
                                                                tone="highlight"
                                                                animated
                                                            />
                                                        </div>
                                                    </>
                                                </BlockStack>
                                            </Box>
                                            )}
                                        </div>
                                        
                                  
                                    
                                    <Bleed marginInline="800" marginBlockEnd="600">
                                        <Box
                                            background="bg-surface-secondary"
                                            paddingInline="600"
                                            paddingBlock="400"
                                            borderRadius="0"
                                        >
                                            <InlineStack align="start" gap="150">
                                                <div>
                                                    <Icon source={InfoIcon} tone="subdued" />
                                                </div>

                                                <Text variant="bodyMd" tone="subdued">
                                                    {type === 'tourismNZ' 
                                                        ? 'Sync listings from Tourism New Zealand.' 
                                                        : 'Sync listings from Eventfinda.'}
                                                </Text>

                                            </InlineStack>
                                        </Box>
                                    </Bleed>
                                </BlockStack>
                            </ErrorBoundary>
                        </Box>
                    ))}
                </BlockStack>
            </BlockStack>
        </ErrorBoundary>
    );
}

export function ErrorBoundaryComponent() {
    return (
        <Banner status="critical" title="Application Error">
            <Text variant="bodyMd">
                An unexpected error occurred. Please try refreshing the page.
            </Text>
        </Banner>
    );
}