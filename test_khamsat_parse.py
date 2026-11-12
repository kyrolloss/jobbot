from pathlib import Path

from sources.khamsat import parse_details, parse_list


SAMPLES = Path(__file__).with_name("samples")


def main() -> None:
    list_html = (SAMPLES / "khamsat_list.html").read_text(encoding="utf-8")
    jobs = parse_list(list_html)
    print(f"عدد الوظايف في القائمة: {len(jobs)}")
    for job in jobs[:3]:
        print(f"- {job.title} | {job.url} | الميزانية: {job.budget or 'غير ظاهرة'}")

    details_html = (SAMPLES / "khamsat_job.html").read_text(encoding="utf-8")
    details = parse_details(details_html)
    print("تفاصيل العينة:")
    print(f"- طول الوصف: {len(details['description'])}")
    print(f"- الميزانية: {details['budget'] or 'غير موجودة'}")
    print(f"- عدد العروض/التعليقات: {details.get('bid_count', 'غير متاح')}")


if __name__ == "__main__":
    main()
