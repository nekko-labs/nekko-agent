"""Order totals for a small online shop: line items, discounts, tax and shipping."""

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")
FREE_SHIPPING_FROM = Decimal("75.00")
FLAT_SHIPPING = Decimal("6.90")
EXPRESS_SURCHARGE = Decimal("9.50")

TAX_RATES = {
    "standard": Decimal("0.22"),
    "reduced": Decimal("0.10"),
    "books": Decimal("0.04"),
    "exempt": Decimal("0"),
}


def money(value):
    """Round to cents the way an invoice does."""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass
class LineItem:
    sku: str
    name: str
    unit_price: Decimal
    quantity: int = 1
    tax_class: str = "standard"

    def subtotal(self):
        return money(self.unit_price * self.quantity)


@dataclass
class Coupon:
    code: str
    percent: Decimal = Decimal("0")
    fixed: Decimal = Decimal("0")
    minimum_spend: Decimal = Decimal("0")
    skus: tuple = ()

    def applies_to(self, item):
        return not self.skus or item.sku in self.skus


@dataclass
class Order:
    items: list = field(default_factory=list)
    coupon: Coupon = None
    express: bool = False
    country: str = "IT"

    def add(self, item):
        for existing in self.items:
            if existing.sku == item.sku:
                existing.quantity += item.quantity
                return existing
        self.items.append(item)
        return item

    def remove(self, sku):
        self.items = [item for item in self.items if item.sku != sku]

    def item_count(self):
        return sum(item.quantity for item in self.items)


def apply_discount(order):
    """Discount per line item, so tax can be computed on what is actually paid."""
    coupon = order.coupon
    discounts = {item.sku: Decimal("0") for item in order.items}
    if coupon is None:
        return discounts
    eligible = [item for item in order.items if coupon.applies_to(item)]
    eligible_total = sum((item.subtotal() for item in eligible), Decimal("0"))
    if eligible_total < coupon.minimum_spend or eligible_total == 0:
        return discounts
    for item in eligible:
        share = item.subtotal() / eligible_total
        amount = item.subtotal() * coupon.percent / 100 + coupon.fixed * share
        discounts[item.sku] = min(money(amount), item.subtotal())
    return discounts


def tax_for(item, discounted_subtotal):
    rate = TAX_RATES.get(item.tax_class)
    if rate is None:
        raise ValueError(f"unknown tax class {item.tax_class!r} for {item.sku}")
    return money(discounted_subtotal * rate)


def shipping_for(order, goods_total):
    if not order.items:
        return Decimal("0")
    cost = Decimal("0") if goods_total >= FREE_SHIPPING_FROM else FLAT_SHIPPING
    if order.express:
        cost += EXPRESS_SURCHARGE
    if order.country != "IT":
        cost += Decimal("4.00")
    return money(cost)


def totals(order):
    """Everything an invoice shows, in cents-exact Decimals."""
    discounts = apply_discount(order)
    lines = []
    goods = Decimal("0")
    tax = Decimal("0")
    for item in order.items:
        discount = discounts[item.sku]
        paid = item.subtotal() - discount
        line_tax = tax_for(item, paid)
        lines.append({
            "sku": item.sku,
            "name": item.name,
            "quantity": item.quantity,
            "subtotal": item.subtotal(),
            "discount": discount,
            "tax": line_tax,
        })
        goods += paid
        tax += line_tax
    shipping = shipping_for(order, goods)
    return {
        "lines": lines,
        "goods": money(goods),
        "discount": money(sum(discounts.values(), Decimal("0"))),
        "tax": money(tax),
        "shipping": shipping,
        "total": money(goods + tax + shipping),
    }


def describe(order):
    """A plain-text receipt, one line per item and the totals at the end."""
    result = totals(order)
    out = []
    for line in result["lines"]:
        out.append(f"{line['quantity']} x {line['name']:<24} {line['subtotal']:>8}")
        if line["discount"]:
            out.append(f"    discount {'':<19} -{line['discount']:>7}")
    out.append(f"{'Goods':<30} {result['goods']:>8}")
    out.append(f"{'Tax':<30} {result['tax']:>8}")
    out.append(f"{'Shipping':<30} {result['shipping']:>8}")
    out.append(f"{'Total':<30} {result['total']:>8}")
    if order.coupon is not None and result["discount"]:
        out.append(f"Coupon {order.coupon.code} saved {result['discount']}")
    return "\n".join(out)


def preview_discount(order, coupon):
    """What a coupon would save, without changing the order."""
    trial = Order(items=list(order.items), coupon=coupon, express=order.express, country=order.country)
    return money(sum(apply_discount(trial).values(), Decimal("0")))
