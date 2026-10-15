// Imported first by the "after" bundle only: the base revision has no Artifacts tab.
import { ArtifactsView } from '../apps/desktop/src/renderer/views/ArtifactsView';
(window as unknown as { __ArtifactsView: unknown }).__ArtifactsView = ArtifactsView;
