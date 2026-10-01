import React from "react";
import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import InspectionApp from "./inspection/App";
const ChatApp = lazy(async () => { await import('./style.css'); return import('./App'); });

createRoot(document.getElementById("root")!).render(<React.StrictMode>{new URLSearchParams(location.search).get('view') === 'chat' ? <Suspense fallback={<p>正在打开图片对话…</p>}><ChatApp /></Suspense> : <InspectionApp />}</React.StrictMode>);
