'use strict';

// Representative text from the user's ChatGPT "Copy response" payload. Keep
// expected Markdown explicit so this fixture does not repeat the normalizer.
exports.copied = String.raw`# 临时第一讲：从零理解 RC 一阶电路

你已经学过电容的定义：

\\[ \boxed{q=Cu_C} \\]

- \\(q\\)：电容正极板上的电荷量。
- \\(u_C\\)：电容两端的电压。

\\[ i=C\frac{du_C}{dt} \\]

\\[ \underbrace{RC\frac{du_C}{dt}}\_{\text{电阻上的电压}} + \underbrace{u_C}\_{\text{电容上的电压}} = U_s \\]

\\[ \int\frac{1}{U_s-u_C}\\,du_C = \int\frac{1}{RC}\\,dt \\]

> [!note]
> 经过 \\(5\tau\\) 后通常接近稳态。
>
> \\[
> u_C(t)=U_s\left(1-e^{-\frac{t}{RC}}\right)
> \\]

| 时间 | 充电完成比例 |
| --- | --- |
| \\(t=\tau\\) | 63.2% |

结束。`;

exports.expected = String.raw`# 临时第一讲：从零理解 RC 一阶电路

你已经学过电容的定义：

\[ \boxed{q=Cu_C} \]

- \(q\)：电容正极板上的电荷量。
- \(u_C\)：电容两端的电压。

\[ i=C\frac{du_C}{dt} \]

\[ \underbrace{RC\frac{du_C}{dt}}_{\text{电阻上的电压}} + \underbrace{u_C}_{\text{电容上的电压}} = U_s \]

\[ \int\frac{1}{U_s-u_C}\,du_C = \int\frac{1}{RC}\,dt \]

> [!note]
> 经过 \(5\tau\) 后通常接近稳态。
>
> \[
> u_C(t)=U_s\left(1-e^{-\frac{t}{RC}}\right)
> \]

| 时间 | 充电完成比例 |
| --- | --- |
| \(t=\tau\) | 63.2% |

结束。`;
