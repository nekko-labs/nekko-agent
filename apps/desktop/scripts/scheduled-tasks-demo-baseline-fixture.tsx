// Pair with NEKKO_TEST_SOURCE pointing at the unchanged base checkout.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FirstWorkflowWizard } from '../src/renderer/components/FirstWorkflowWizard';
import '../src/renderer/styles.css';
createRoot(document.getElementById('root')!).render(<FirstWorkflowWizard onCreate={() => { throw Error('Unexpected creation'); }} onBrowse={() => {}} />);
