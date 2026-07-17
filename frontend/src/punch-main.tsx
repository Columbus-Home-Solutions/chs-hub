import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/quote.css";
import "./styles/portal.css";
import "./styles/punch.css";
import { PunchPage } from "./views/punch/PunchPage";

const root = document.getElementById("punch");
if (root) render(<PunchPage />, root);
