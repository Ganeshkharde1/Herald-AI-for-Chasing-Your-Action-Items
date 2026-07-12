import json
import os
import sys
from dotenv import load_dotenv

# Make sure we can import from the parent directory
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from langfuse.decorators import langfuse_context, observe
from llm import extract_meeting_data, call_hermes

load_dotenv()

JUDGE_PROMPT = """You are an expert grading assistant.
Compare the actual extracted action items to the expected action items.
Expected:
{expected}

Actual:
{actual}

Did the actual extraction successfully capture all the expected action items and assign them to the correct owners?
Respond with ONLY "1" if it is a pass, or "0" if it is a fail."""

@observe()
def evaluate_extraction(transcript: str, expected: list):
    # This call is traced automatically because extract_meeting_data has @observe
    print(f"Running extraction for transcript: {transcript[:30]}...")
    
    actual_data = extract_meeting_data(transcript)
    actual_items = actual_data.get("action_items", [])
    
    print(f"Extracted: {actual_items}")
    
    # Use Hermes as a Judge
    prompt = JUDGE_PROMPT.format(
        expected=json.dumps(expected, indent=2),
        actual=json.dumps(actual_items, indent=2)
    )
    
    # We call hermes directly for the evaluation
    grade_str = call_hermes(prompt, "Please grade the extraction.")
    
    try:
        grade = int(grade_str.strip())
        grade = 1 if grade > 0 else 0
    except ValueError:
        print(f"Warning: Judge returned invalid grade: {grade_str}")
        grade = 0
        
    print(f"Score: {grade}/1")
    
    # Attach score to the current Langfuse trace!
    langfuse_context.score_current_observation(
        name="extraction_accuracy",
        value=grade
    )
    return grade

def main():
    dataset_path = os.path.join(os.path.dirname(__file__), 'dataset.json')
    with open(dataset_path, 'r') as f:
        dataset = json.load(f)
        
    total = len(dataset)
    passed = 0
    
    for item in dataset:
        score = evaluate_extraction(item["transcript"], item["expected_action_items"])
        passed += score
        
    print(f"\nFinal Score: {passed}/{total}")
    
    # Flush Langfuse traces before exiting
    print("Flushing traces to Langfuse...")
    langfuse_context.flush()
    print("Done!")

if __name__ == "__main__":
    main()
