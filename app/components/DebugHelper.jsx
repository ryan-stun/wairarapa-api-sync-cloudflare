import { useState } from 'react';
import { Button, Popover, ActionList, Text, ButtonGroup, TextField, Box } from '@shopify/polaris';
import { Form, useSubmit } from '@remix-run/react';

export function DebugHelper() {
  const [active, setActive] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const submit = useSubmit();

  // Hidden button toggle - triple-click to show/hide
  const handleTripleClick = (e) => {
    if (e.detail === 3) {
      setShowDebug(!showDebug);
    }
  };

  const togglePopover = () => setActive(!active);
  const closePopover = () => setActive(false);

  const handleFetchSample = () => {
    const formData = new FormData();
    formData.append('action', 'fetch-sample');
    submit(formData, { method: 'post' });
    closePopover();
  };

  if (!showDebug) {
    // Invisible element that can be triple-clicked to show the debug tools
    return (
      <div 
        onClick={handleTripleClick} 
        style={{ 
          position: 'fixed', 
          bottom: '10px', 
          right: '10px', 
          width: '30px', 
          height: '30px', 
          cursor: 'default',
          zIndex: 1000 
        }}
      />
    );
  }

  return (
    <div style={{ 
      position: 'fixed', 
      bottom: '20px', 
      right: '20px', 
      zIndex: 1000 
    }}>
      <Popover
        active={active}
        activator={
          <Button onClick={togglePopover} size="slim" monochrome>
            Debug Tools
          </Button>
        }
        onClose={closePopover}
      >
        <Popover.Pane>
          <Box padding="400">
            <Text variant="headingMd" as="h4">Tourism NZ Debug Tools</Text>
            <ButtonGroup>
              <Button 
                onClick={handleFetchSample} 
                size="slim"
              >
                Fetch Sample Data
              </Button>
              <Button 
                onClick={() => setShowDebug(false)} 
                size="slim" 
                tone="critical"
              >
                Hide Debug Tools
              </Button>
            </ButtonGroup>
          </Box>
        </Popover.Pane>
      </Popover>
    </div>
  );
}