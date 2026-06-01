import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/quote.css";
import "./styles/portal.css";
import { PortalApp } from "./views/portal/PortalApp";

const root = document.getElementById("portal");
if (root) {
  render(<PortalApp />, root);
}
