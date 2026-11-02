// The real App (layout-evidence-fixture) plus the runner card's workflow action. Synthetic, never contacts a host.
import './layout-evidence-fixture';
import { connectToWorkflow } from '../src/renderer/components/RunnerReady';

Object.assign(window, { connectToWorkflow });
