import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/quote.css";
import { QuotePage } from "./views/public/QuotePage";

const root = document.getElementById("quote");
if (root) {
  render(<QuotePage />, root);
}
