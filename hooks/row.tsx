import type { ClientModule } from 'claude-code'

/** One run of text in a row: `isFill` takes the free room and cuts its end. */
export type Part = { text: string; color?: string; isBold?: boolean; isDim?: boolean; isFill?: boolean }

export type RowProps = { parts: Part[] }

type RowState = { isHovered: boolean }

/**
 * A row of the task history on a surface whose buttons flicker under the
 * pointer: drawn as plain text and pressed anywhere on it, by a click or by
 * Enter once a click gave it the focus. A press posts `{ press: true }`.
 */
const Row: ClientModule<RowProps, RowState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isHovered = surface.state?.isHovered === true

  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') {
      surface.post({ press: true })
    } else if (event.type === 'enter' || event.type === 'leave') {
      surface.setState({ isHovered: event.type === 'enter' })
    }
  })
  surface.onKey(event => {
    if (event.key === 'return' || event.key === ' ') {
      surface.post({ press: true })
    }
  })

  // Under the pointer the row lights in the accent colour; nothing moves.
  const draw = (part: Part) => {
    const color = part.color ?? (isHovered ? 'claude' : undefined)

    return (
      <Text
        {...(color !== undefined && { color })}
        {...(part.isBold === true && { bold: true })}
        {...(part.isDim === true && !isHovered && { dimColor: true })}
        {...(part.isFill === true && { wrap: 'truncate-end' as const })}
      >
        {part.text}
      </Text>
    )
  }

  return (
    <Box flexDirection="row" gap={1} width="100%">
      {props.parts.map(part =>
        part.isFill ? (
          <Box flexGrow={1} flexShrink={1}>
            {draw(part)}
          </Box>
        ) : (
          draw(part)
        ),
      )}
    </Box>
  )
}

export default Row
