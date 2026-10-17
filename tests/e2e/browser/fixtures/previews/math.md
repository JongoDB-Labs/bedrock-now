# Formulas and diagrams

Inline: $a^2 + b^2 = c^2$; display:

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

Prices stay text: it costs $5 and $10. Code stays code: `echo $HOME $PATH`.

```mermaid
graph LR
  A[Markdown] --> B[Diagram]
```

Hostile: $\href{javascript:alert(1)}{x}$ $\url{http://127.0.0.1:9/md-url}$ $\includegraphics{http://127.0.0.1:9/md-graphic.png}$ $\htmlStyle{color:red}{x}$
$\def\a{\a\a}\a$; and two that would set style attributes in MathML: $\pmb{x}$ $\fcolorbox{red}{blue}{y}$
and a formula that does not parse: $\frac{1}{$.

Formulas stay in their boxes: words before $x\kern{-9em}\text{MOVEDLEFT}$ and $y\raisebox{-3em}{\text{MOVEDDOWN}}$ words after.

A line under them.
