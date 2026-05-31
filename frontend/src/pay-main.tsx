import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/quote.css";
import { PayPage } from "./views/public/PayPage";

const root = document.getElementById("pay");
if (root) {
  render(<PayPage />, root);
}
