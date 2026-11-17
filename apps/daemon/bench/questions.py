"""The fixed questions of `just bench-ask` (D100).

Each question names the page that holds the answer and words the answer must contain, so a
run can say whether the right page was cited and the fact came out, not only how fast it was.
`EXAMPLE` is for `examples/vault`; `GENERATED` is for the vault `gen_vault.py` writes, which
plants the `FACTS` below among a thousand pages of filler.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Question:
    text: str
    page: str  # vault path of the page that answers it
    expect: tuple[str, ...]  # the answer contains at least one of these (case-insensitive)


EXAMPLE = [
    Question(
        "How many people work in the field at Fernhill?", "Customers/Fernhill", ("40", "forty")
    ),
    Question(
        "Who decides at Fernhill, and what do they care about?", "Customers/Fernhill", ("Ines",)
    ),
    Question(
        "What was decided about offline mode versus export in the product sync?",
        "Meetings/2026-11-10 Product sync",
        ("ahead of export", "before export", "offline mode goes", "January", "Now"),
    ),
    Question(
        "By how much did the onboarding changes cut setup time?",
        "Meetings/2026-11-10 Product sync",
        ("four", "4 "),
    ),
    Question(
        "Who has to estimate the sync conflict screen, and by when?",
        "Meetings/2026-11-10 Product sync",
        ("Jonas",),
    ),
    Question(
        "What are the success measures for offline mode?",
        "Product/Feature specs/Offline mode",
        ("80",),
    ),
    Question(
        "What is out of scope for offline mode?",
        "Product/Feature specs/Offline mode",
        ("photo", "template"),
    ),
    Question(
        "What did the field study find about failed saves?",
        "Research/Field study · Working without signal",
        ("trust",),
    ),
    Question(
        "How often do sync conflicts occur according to the logs?",
        "Meetings/2026-11-10 Product sync",
        ("four hundred", "400"),
    ),
    Question("What is Fernhill's next step, and who owns it?", "Customers/Fernhill", ("Priya",)),
]


@dataclass(frozen=True)
class Fact:
    """A sentence planted on one generated page, and the question it answers."""

    page: str
    heading: str
    sentence: str
    question: str
    expect: tuple[str, ...]


FACTS = [
    Fact(
        "Customers/Brightwater Dairy",
        "Contract",
        "The contract with Brightwater Dairy renews on 3 March 2027 at 1,850 euros per month.",
        "When does the Brightwater Dairy contract renew, and at what monthly price?",
        ("1,850", "1850"),
    ),
    Fact(
        "Invoices/Invoice 2026-0317",
        "Status",
        "Invoice 2026-0317 to Halden Freight for 18,400 euros is 46 days overdue.",
        "Which invoice to Halden Freight is overdue, and by how many days?",
        ("46",),
    ),
    Fact(
        "Meetings/2026-09-22 Pricing review",
        "Decisions",
        "We decided to raise the Team plan from 12 to 14 euros per seat from 1 January.",
        "What did the pricing review decide about the Team plan?",
        ("14",),
    ),
    Fact(
        "Projects/Lantern migration",
        "Risks",
        "The Lantern migration is blocked until the customer exports 2.3 terabytes of archives.",
        "What is blocking the Lantern migration?",
        ("2.3", "archive"),
    ),
    Fact(
        "People/Odile Marchetti",
        "Role",
        "Odile Marchetti leads procurement at Northgate Mills and signs every order above "
        "5,000 euros.",
        "Who signs large orders at Northgate Mills, and above which amount?",
        ("Odile", "5,000", "5000"),
    ),
    Fact(
        "Research/Interview round 7",
        "Key claims",
        "Seven of nine interviewed planners said they export to a spreadsheet every Friday.",
        "What did interview round 7 find about exporting to spreadsheets?",
        ("seven", "7 of", "Friday"),
    ),
    Fact(
        "Projects/Quarry dashboard",
        "Timeline",
        "The Quarry dashboard pilot starts on 12 February with two depots, Velden and Roermond.",
        "Which depots take part in the Quarry dashboard pilot?",
        ("Velden", "Roermond"),
    ),
    Fact(
        "Customers/Tessel Marine",
        "What they need",
        "Tessel Marine needs tide tables in the mobile app before they sign for a second year.",
        "What does Tessel Marine need before signing for a second year?",
        ("tide",),
    ),
    Fact(
        "Meetings/2026-10-06 Support retro",
        "Notes",
        "Median first response time dropped from 9 hours to 2 hours after the shared inbox moved.",
        "How did the first response time change after the shared inbox moved?",
        ("2 hours", "two hours"),
    ),
    Fact(
        "Invoices/Invoice 2026-0288",
        "Status",
        "Invoice 2026-0288 was credited in full because the Almere shipment arrived damaged.",
        "Why was invoice 2026-0288 credited?",
        ("damaged", "Almere"),
    ),
]

GENERATED = [Question(f.question, f.page, f.expect) for f in FACTS]
