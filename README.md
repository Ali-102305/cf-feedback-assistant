# Cloudflare Feedback Assistant

A prototype product feedback aggregation and analysis tool built using Cloudflare Workers.

## Overview
This project demonstrates how product feedback from multiple channels can be aggregated,
analysed, and summarised to help product managers identify themes, sentiment, and
actionable insights.

The prototype simulates real-world feedback noise from sources such as:
- Customer Support
- GitHub Issues
- Discord
- Email
- X / Twitter
- Community forums

## Features
- Feedback submission interface
- Mock data seeding to simulate real multi-channel feedback streams
- Insights dashboard showing:
  - Feedback volume by source
  - Latest feedback submissions
  - AI-generated executive summary, themes, sentiment, and recommended actions

## Cloudflare Products Used
- **Cloudflare Workers** – host the application and API routes
- **D1** – store structured feedback data
- **Workers AI** – generate structured insights from user feedback
- **Workers KV** – cache AI summaries for performance and cost efficiency

## Live Demo
https://cf-feedback-assistant.alichoudhury.workers.dev

## How to Use
1. Visit the live demo link
2. Seed mock feedback data using the “Seed mock data” option
3. View aggregated insights on the Insights dashboard
4. Submit new feedback to see insights update automatically

## Notes
This prototype was built as part of a Cloudflare Product Manager Intern assignment.
No real third-party integrations are used; all data is mocked to reflect realistic
product feedback scenarios.
