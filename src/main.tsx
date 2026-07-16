import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Design system (SIM-43 / DS-5): ssc-ui ships a precompiled, standalone token +
// component stylesheet. Imported BEFORE ./index.css so jobhunt's own :root
// (color-scheme: dark) and app styles cascade last and win any overlap. The app
// runs the fleet's dark default, activated by class="dark" on <html> (index.html);
// ssc-ui's .dark tokens are byte-identical to jobhunt's --color-* palette.
import "ssc-ui/styles.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
