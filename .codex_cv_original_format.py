from pathlib import Path
import sys

sys.path.insert(0, "/tmp/ferit_cv_fix/.deps")

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


OUT = Path("/Users/feritzcan/Downloads/Ferit_Ozcan_CV_TermLoop_original_format.pdf")
FONT_DIR = Path("/System/Library/Fonts/Supplemental")


def register_fonts():
    pdfmetrics.registerFont(TTFont("TNR", str(FONT_DIR / "Times New Roman.ttf")))
    pdfmetrics.registerFont(TTFont("TNR-Bold", str(FONT_DIR / "Times New Roman Bold.ttf")))


def para(text, style):
    return Paragraph(text, style)


def bullet_items(items, styles):
    return [para(f"&bull;&nbsp;&nbsp;{item}", styles["bullet"]) for item in items]


def section(title, rows, styles):
    flow = [
        HRFlowable(width="100%", thickness=0.8, color=colors.black, spaceBefore=7, spaceAfter=7),
    ]
    data = []
    first = True
    for left, right in rows:
        data.append(
            [
                para(title if first else "", styles["section"]),
                para(left, styles["date"]),
                right,
            ]
        )
        first = False
    table = Table(data, colWidths=[40 * mm, 34 * mm, 103 * mm], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    flow.append(table)
    return flow


def role(title, description, bullets, styles):
    parts = [para(title, styles["role"]), para(description, styles["body"])]
    parts.extend(bullet_items(bullets, styles))
    return parts


def project(title, description, styles):
    return [para(title, styles["role"]), para(description, styles["body"])]


def build():
    register_fonts()
    styles = {
        "name": ParagraphStyle("name", fontName="TNR-Bold", fontSize=13.5, leading=16, alignment=TA_CENTER, spaceAfter=10),
        "contact": ParagraphStyle("contact", fontName="TNR", fontSize=8.5, leading=10, alignment=TA_CENTER, spaceAfter=14),
        "section": ParagraphStyle("section", fontName="TNR", fontSize=8.5, leading=10.5, charSpace=1.4),
        "date": ParagraphStyle("date", fontName="TNR", fontSize=8.6, leading=11),
        "role": ParagraphStyle("role", fontName="TNR", fontSize=10.4, leading=13, spaceAfter=6),
        "body": ParagraphStyle("body", fontName="TNR", fontSize=8.75, leading=10.4, spaceAfter=2, alignment=TA_LEFT),
        "bullet": ParagraphStyle("bullet", fontName="TNR", fontSize=8.75, leading=10.3, leftIndent=12, firstLineIndent=-9, spaceAfter=0),
        "skills": ParagraphStyle("skills", fontName="TNR", fontSize=8.75, leading=10.8),
    }

    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=14 * mm,
        bottomMargin=13 * mm,
        title="Ferit Özcan, Staff software engineer",
        author="Ferit Özcan",
    )

    story = [
        para("Ferit Özcan, Staff software engineer", styles["name"]),
        para("Berlin, Berlin, Germany, 1727015066, feritzcan93@gmail.com", styles["contact"]),
    ]

    profile = (
        "Innovative Staff Backend Engineer with expertise in architecting scalable, low-latency systems and "
        "developer tools. Creator of TermLoop, an AI-first macOS terminal product for developers using coding "
        "agents. Experienced in AWS cloud architecture, API design, integration testing infrastructure, "
        "event-driven architectures, multi-region deployments, and zero-downtime migration work for systems "
        "serving over 10 million users."
    )
    story += section("P R O F I L E", [("", para(profile, styles["body"]))], styles)

    employment = [
        (
            "2024 — Present",
            role(
                "Founder / Principal Engineer, TermLoop",
                "Built TermLoop, an AI-first macOS terminal product for developers using coding agents, combining a native terminal, agent sidebar, project workspaces, and remote control APIs.",
                [
                    "Architected a native macOS app using Swift, SwiftUI, and Ghostty-based terminal rendering.",
                    "Designed agent workflows for launching, monitoring, and interacting with coding agents inside project workspaces.",
                    "Implemented workspace and git worktree lifecycle management, prompt templates, and agent input composition.",
                    "Built Unix socket and TCP control layers used by local automation and a companion mobile client.",
                ],
                styles,
            ),
        ),
        (
            "Aug 2025",
            role(
                "Staff software engineer, Apcoa Group",
                "Directed migration of 10M+ users, architecting zero-downtime pipelines from legacy systems to a unified platform. Developed debuggable integration test infrastructure in C# using Aspire for local and real deployment execution. Engaged in backend stack development, focusing on API design, database optimization, and cloud deployment.",
                [
                    "Spearheaded migration project, ensuring seamless transition for 10M+ users.",
                    "Created robust test infrastructure, improving integration reliability.",
                    "Optimised backend processes, enhancing overall system performance.",
                    "Championed refactoring initiatives, modernising legacy components.",
                ],
                styles,
            ),
        ),
        (
            "Aug 2024 — Aug 2025",
            role(
                "Senior software engineer, Apcoa Group",
                "Oversaw backend delivery of high-impact product features from design to rollout. Adapted outdated code to enhance performance.",
                [
                    "Developed authorization and payment flows with various PSPs.",
                    "Boosted developer productivity through .NET Aspire for end-to-end microservices debugging.",
                    "Created System Validator to monitor session states, detect data inconsistencies, and support self-healing with fix scripts.",
                ],
                styles,
            ),
        ),
        (
            "Jan 2022 — Jan 2024",
            role(
                "Senior backend engineer, Gybe Games",
                "Design and implement AWS multi-region architectures using Terraform for scalable, low-latency backend systems. Develop tycoon and idle game loops with a server-authoritative model on .NET and C#. Integrate systems like Friendship and clans using gRPC and manage authentication. Serve as sole backend developer in a 30-person team.",
                [
                    "Designed multi-region cloud architecture on AWS.",
                    "Developed and shipped game features as sole backend engineer.",
                    "Integrated gRPC for system connections and authentication.",
                    "Created SDK for use across all company games.",
                ],
                styles,
            ),
        ),
        (
            "Jan 2020 — Jan 2022",
            role(
                "Senior backend engineer, Mudio games",
                "Spearheaded backend and infrastructure development as sole team member. Developed event-based architecture for client (Unity) and server (.NET), ensuring server authority over game events. Designed and implemented AWS cloud architecture with Terraform for scalable, low-latency backend systems.",
                [
                    "Developed event-driven architecture ensuring server authority.",
                    "Implemented AWS infrastructure for global scalability.",
                    "Designed comprehensive game process management systems.",
                    "Deployed multiplayer games on AWS GameLift.",
                ],
                styles,
            ),
        ),
        (
            "Aug 2017 — Oct 2020",
            role(
                "Backend developer - Senior backend developer, Accenture",
                "Design and develop Construction Management application for 10,000+ IoT devices, processing millions of data points daily. Collaborate on multiple projects with hands-on experience in diverse technologies.",
                [
                    "Utilised .NET, AWS, and Azure to enhance application performance.",
                    "Integrated CosmosDB and PostgreSQL for efficient data management.",
                    "Championed Java implementations to streamline backend processes.",
                ],
                styles,
            ),
        ),
    ]
    story += section("E M P L O Y M E N T  H I S T O R Y", employment, styles)

    story += section(
        "E D U C A T I O N",
        [("", para("Bachelor's, Bilkent university, Turkey", styles["role"]))],
        styles,
    )

    freelance = [
        (
            "",
            project(
                "Virtual classroom - Next.js, Dotnet",
                "Developed a full-stack EdTech platform (SanalDershanem) using Next.js 14, .NET Web API, and PostgreSQL. Built feature-based modules for courses, exams, live sessions, scheduling, role-based authentication (JWT + Identity), and AI as student coach.",
                styles,
            ),
        ),
        (
            "",
            project(
                "Appointment Tracker - Visa consultant app, Next.js - selenium",
                "Built an appointment tracker for visa appointments in Turkey. The system had scalable scrapers in Python and Selenium, plus a fully featured admin dashboard for visa consultants.",
                styles,
            ),
        ),
        (
            "",
            project(
                "Swift and react native",
                "Have done tons of freelance Swift and React Native apps during first 5 years of my career.",
                styles,
            ),
        ),
    ]
    story += section("F R E E L A N C E  P R O J E C T S", freelance, styles)

    skills = (
        "AWS<br/>.NET Core<br/>C#<br/>API Design<br/>Integration Testing<br/>Event-Driven Architecture<br/>"
        "React<br/>React-native<br/>Swift<br/>SwiftUI<br/>Ghostty<br/>PostgreSQL - CosmosDB - MongoDB and more"
    )
    story += section("S K I L L S", [("", para(skills, styles["skills"]))], styles)

    doc.build(story)
    print(OUT)


if __name__ == "__main__":
    build()
