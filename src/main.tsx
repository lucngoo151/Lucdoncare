import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { RootErrorBoundary } from "@/shared/ui";
import { initGlobalErrorHandlers } from "@/shared/utils/globalErrorHandlers";
import { initTelemetry } from "@/shared/telemetry";
import { initBackgroundStorageAnalytics } from "@/shared/utils/cacheManager";
import { initApiEndpointProbe } from "@/shared/api";

// Initialize global uncaught error, telemetry listeners, background storage tracker, and edge health probe
initGlobalErrorHandlers();
initTelemetry();
initBackgroundStorageAnalytics();
initApiEndpointProbe();

const rootElement = document.getElementById("root");

// Frameless Windows windows need native draggable regions so Windows can
// apply its edge snapping behavior during a title bar drag.
if (window.linerElectron?.platform) {
  document.documentElement.dataset.platform = window.linerElectron.platform;
}

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}

