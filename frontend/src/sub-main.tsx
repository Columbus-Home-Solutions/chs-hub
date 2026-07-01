import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/portal.css";
import "./styles/punch.css";
import { SubPage } from "./views/public/SubPage";

const root = document.getElementById("sub");
if (root) render(<SubPage />, root);
