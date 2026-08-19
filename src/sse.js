export function writeSse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function streamCompletedResponse(res, response) {
  const inProgress = { ...response, status: "in_progress", output: [], usage: null };
  writeSse(res, { type: "response.created", response: inProgress });
  writeSse(res, { type: "response.in_progress", response: inProgress });

  response.output.forEach((item, outputIndex) => {
    if (item.type === "message") {
      const text = item.content?.[0]?.text || "";
      const pending = { ...item, status: "in_progress", content: [] };
      writeSse(res, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: pending
      });
      writeSse(res, {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] }
      });
      if (text) {
        writeSse(res, {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          delta: text
        });
      }
      writeSse(res, {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text
      });
      writeSse(res, {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: item.content[0]
      });
    } else if (item.type === "function_call") {
      writeSse(res, {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", arguments: "" }
      });
      writeSse(res, {
        type: "response.function_call_arguments.done",
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments
      });
    }

    writeSse(res, {
      type: "response.output_item.done",
      output_index: outputIndex,
      item
    });
  });

  writeSse(res, { type: "response.completed", response });
  res.write("data: [DONE]\n\n");
  res.end();
}
