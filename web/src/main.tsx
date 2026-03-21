import React from "react";
import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import "./index.css";

const domain = import.meta.env.VITE_AUTH0_DOMAIN as string;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string;

console.log("Auth0 config", { domain, clientId, audience });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      onRedirectCallback={(appState) => {
        const appReturnTo = (appState as { returnTo?: string } | undefined)?.returnTo;
        const storedStepUpReturnTo = window.localStorage.getItem("cc_step_up_return_to");
        const returnTo = appReturnTo || storedStepUpReturnTo;
        if (returnTo && returnTo.startsWith("/")) {
          const current = `${window.location.pathname}${window.location.search}`;
          if (current !== returnTo) {
            window.history.replaceState({}, document.title, returnTo);
          }
        }
      }}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience,
        scope: "openid profile email offline_access",
      }}
      cacheLocation="localstorage"
      useRefreshTokens
      useRefreshTokensFallback
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Auth0Provider>
  </React.StrictMode>
);