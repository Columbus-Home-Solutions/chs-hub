import { render } from "preact";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/quote.css";
import { BookPage } from "./views/book/BookPage";

const root = document.getElementById("book");
if (root) render(<BookPage />, root);
