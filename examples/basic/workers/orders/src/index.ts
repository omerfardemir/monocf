export default {
  async fetch(): Promise<Response> {
    return Response.json({orders: []})
  },
}
