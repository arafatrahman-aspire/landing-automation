import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";
import App from "./App";
import CampaignListPage from "./pages/CampaignListPage";
import NewCampaignPage from "./pages/NewCampaignPage";
import RunDetailPage from "./pages/RunDetailPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<CampaignListPage />} />
          <Route path="new" element={<NewCampaignPage />} />
          <Route path="runs/:runId" element={<RunDetailPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
