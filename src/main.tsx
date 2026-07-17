import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Auth gate (SIM-391): wraps the WHOLE app so on the auth-walled private
// instance nothing but GET /api/auth/status can fire before login - App and
// all its data hooks mount only once the gate passes. Auth off (laptop dev,
// public demo) renders App unchanged.
import { LoginGate } from "./components/LoginGate";
// Design system (SIM-43 / DS-5): ssc-ui ships a precompiled, standalone token +
// component stylesheet. Imported BEFORE ./index.css so jobhunt's own :root
// (color-scheme: dark) and app styles cascade last and win any overlap. The app
// runs the fleet's dark default, activated by class="dark" on <html> (index.html);
// ssc-ui's .dark tokens are byte-identical to jobhunt's --color-* palette.
import "ssc-ui/styles.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LoginGate>
      <App />
    </LoginGate>
  </React.StrictMode>
);
