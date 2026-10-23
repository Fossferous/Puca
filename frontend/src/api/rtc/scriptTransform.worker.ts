/**
 * The worker the mesh's RTCRtpScriptTransforms run in (scriptTransform.ts
 * starts it; scriptTransformWorker.ts is all of it).
 */
import { serveScriptTransforms, type ScriptTransformScope } from './scriptTransformWorker';

serveScriptTransforms(self as unknown as ScriptTransformScope);
